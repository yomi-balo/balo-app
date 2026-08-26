/**
 * BAL-412 (ADR-1044 §7, D5) — THE BILLING FLOOR at the `apps/api` boundary.
 *
 * ⚠ IT IS NOT A THIRD CONSTANT. It reads `resolveMeetingTimers().noShowFloorMs` — the SAME
 * env-overridable value (`MEETING_NO_SHOW_FLOOR_MINUTES`) the lifecycle sweep and
 * `GET /meetings/:id/state` already use — and converts it to whole minutes. One number, one
 * override, one injection seam. `packages/shared/src/meetings/timers.ts`'s `NO_SHOW_FLOOR_MS`
 * itself derives from `bounds.ts`'s `MIN_MEETING_MINUTES`, so all three — the booking minimum,
 * the no-show floor timer, and this settlement floor — move together from ONE edit.
 *
 * ⚠ `platform_config` (BAL-398 / PR #180) IS NOT ON MAIN — verified in this worktree: no
 * `platform_config` schema, no migration, and `bounds.ts` says so in code. ADR-1044's
 * "BAL-398 admin minimum ≥ 15" constraint is therefore NOT ASSERTABLE and is OUT OF SCOPE (D5).
 * When BAL-398 lands this function is its natural first migration.
 *
 * ⚠ READ AT CALL TIME, NOT IMPORT TIME — same discipline as `resolveMeetingTimers` itself, so a
 * test can set `process.env` before calling and merely importing this module is never
 * environment-dependent.
 *
 * ⚠⚠ **F5 — THE FLOOR IS BOUNDED FROM ABOVE HERE, AND IT MUST BE.** `parseMinutes`
 * (`meeting-timers.ts`) rejects NaN / non-finite / `<= 0` but NOTHING rejects an absurdly LARGE
 * value. The floor is not merely a timer: `resolveBillingFloorMs()` feeds
 * `resolveMeetingSettlement`, so an operator who sets `MEETING_NO_SHOW_FLOOR_MINUTES=900`
 * thinking seconds would make every `no_show_client` settlement bill **900 minutes** off-session
 * against the stored company mandate, and would pin reported runway at 0 platform-wide.
 * `finalizeDurationBodySchema` already caps its `minutes` at `MAX_SESSION_MINUTES` for exactly
 * this reason; this is the same guard on the config seam.
 *
 * The bound is `MAX_MEETING_MINUTES` (`@balo/shared/meetings`) — the widest single meeting
 * window that can be BOOKED. A floor above it could never be reached by a legitimate
 * consultation, so it is, definitionally, a misconfiguration. An out-of-range override is
 * **DISCARDED WHOLESALE back to the shipped default**, never clamped to the bound: clamping
 * would still bill 480 minutes per no-show and would read, in the logs, as though the operator's
 * number had been honoured. Discarding matches `resolveMeetingTimers`'s own posture ("a
 * violation discards ALL overrides rather than the offending one") and is loud (`log.error`).
 */
import { DEFAULT_MEETING_TIMERS, MAX_MEETING_MINUTES } from '@balo/shared/meetings';
import { MAX_SESSION_MINUTES } from '@balo/shared/pricing';
import { createLogger } from '@balo/shared/logging';
import { resolveMeetingTimers } from './meeting-timers.js';

const log = createLogger('billing-floor-config');

const MS_PER_MINUTE = 60_000;

/**
 * The billing floor in milliseconds — `resolveMeetingTimers().noShowFloorMs`, restated, with
 * the F5 upper bound applied. Above `MAX_MEETING_MINUTES` the override is discarded and the
 * shipped default is returned instead.
 */
export function resolveBillingFloorMs(): number {
  const resolvedMs = resolveMeetingTimers().noShowFloorMs;
  if (resolvedMs > MAX_MEETING_MINUTES * MS_PER_MINUTE) {
    log.error(
      {
        variable: 'MEETING_NO_SHOW_FLOOR_MINUTES',
        resolvedMinutes: resolvedMs / MS_PER_MINUTE,
        maxMinutes: MAX_MEETING_MINUTES,
        fallbackMinutes: DEFAULT_MEETING_TIMERS.noShowFloorMs / MS_PER_MINUTE,
      },
      'MEETING_NO_SHOW_FLOOR_MINUTES exceeds MAX_MEETING_MINUTES — the billing floor is a MONEY ' +
        'input (every no-show settles at it, charged off-session against the stored mandate), so ' +
        'the override is DISCARDED and the shipped default used. Check the units: this value is ' +
        'MINUTES, not seconds.'
    );
    return DEFAULT_MEETING_TIMERS.noShowFloorMs;
  }
  return resolvedMs;
}

/** The billing floor in whole minutes — what `credit_sessions.billing_floor_minutes` snapshots. */
export function resolveBillingFloorMinutes(): number {
  return Math.round(resolveBillingFloorMs() / MS_PER_MINUTE);
}

/**
 * BAL-466 (D13) — PRODUCTION-ONLY STARTUP GUARD. `apps/web`'s `get-drawdown-state.ts` mirrors
 * the shipped default (`MIN_MEETING_MINUTES`) rather than this env-resolved floor, because it
 * cannot read `process.env.MEETING_NO_SHOW_FLOOR_MINUTES` — that reader lives in `apps/api`
 * ALONE (ADR-1049 D8) and `@balo/shared/meetings` is deliberately client-reachable. So ANY
 * override here makes the two silently disagree on a MONEY figure: the in-call panel's
 * `minutesOfRunway` ESTIMATE drifts from the actual billing floor `resolveMeetingSettlement`
 * charges. Dev and test may still set it locally; a real deployment must not be able to.
 *
 * ⚠ THROWS — DOES NOT LOG-AND-CONTINUE, unlike `index.ts`'s two vendor-secret warnings at
 * boot, which degrade a feature loudly but survive. This one would otherwise corrupt a money
 * DISPLAY silently, with nothing in Axiom pointing at why the two figures disagree — a
 * crash-loop is the correct trade for a config mistake nobody would otherwise see. Removing
 * this env var's mirror entirely (routing the web read through the gated api, or snapshotting
 * the floor onto the credit-session row) is the long-term fix and is deferred to **BAL-398**
 * (the platform-config ticket, still unmerged) — this is the structural stopgap until then.
 *
 * ⚠ CALL THIS AT BOOT, NOT ON EVERY REQUEST — `apps/api/src/index.ts` is the one call site.
 *
 * ⚠⚠ F2 — "SET" MEANS WHAT `meeting-timers.ts`'s `parseMinutes` SAYS IT MEANS, NOT MERELY
 * "PRESENT". Railway writes an EMPTY STRING for an unset variable in some flows —
 * `meeting-timers.ts:66` (the only actual CONSUMER of this variable) treats a blank string as
 * ABSENT for exactly that reason, and `resolveBillingFloorMinutes()` correctly falls back to the
 * default for it. A guard that instead throws on mere key-presence would crash-loop the API on a
 * deploy shape that changes nothing about the resolved floor — checking `=== undefined` alone
 * does that. Mirror `parseMinutes`'s emptiness rule exactly so the two agree on what "set" means.
 */
export function assertNoShowFloorOverrideUnsetInProduction(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const raw = process.env.MEETING_NO_SHOW_FLOOR_MINUTES;
  if (raw === undefined || raw.trim().length === 0) return; // ⚠ blank ⇒ ABSENT, per meeting-timers.ts
  throw new Error(
    'MEETING_NO_SHOW_FLOOR_MINUTES must not be set in production — apps/web mirrors the ' +
      'shipped default (MIN_MEETING_MINUTES) and cannot read this env var, so an override ' +
      'here makes the in-call panel and the actual billing floor silently disagree on a ' +
      'MONEY figure. Unset it, or route the web read through the gated api first (BAL-398).'
  );
}

/**
 * BAL-412 (F1) — THE UPPER BOUND ON A PRESENCE SETTLEMENT, in whole minutes, injected into
 * `resolveMeetingSettlement`'s required `maxBillableMinutes`.
 *
 * ⚠ IT IS NOT A NEW CONSTANT AND IT IS NOT ENV-OVERRIDABLE. It restates
 * `MAX_SESSION_MINUTES` — the same safety cap the reaper's force-end and both
 * `estimatedMinutes` / `finalizeDuration` Zod schemas already use — so a presence-sourced
 * session cannot settle above the ceiling every OTHER provenance is already held to. It lives
 * beside `resolveBillingFloorMs()` because these are the two settlement bounds and a reader
 * looking for one must find the other.
 *
 * ⚠ NOT `MAX_MEETING_MINUTES` (480). That bounds a SCHEDULED WINDOW; this bounds a CONNECTED,
 * CHARGED session. `bounds.ts` says explicitly: "Do not unify them."
 */
export function resolveMaxBillableMinutes(): number {
  return MAX_SESSION_MINUTES;
}
