/**
 * BAL-129 — VENDOR FREE/BUSY, RESOLVED IN EXACTLY ONE PLACE FOR BOTH READS.
 *
 * ⚠⚠ THIS MODULE EXISTS TO MAKE ONE SPECIFIC DIVERGENCE UNREPRESENTABLE, and it is the ONLY
 * resolver input that was not already shared. `./resolver-inputs.ts` extracted the three
 * ROW projections (rules, consultations, overrides) so the two reads cannot interpret the
 * same rows differently. Vendor free/busy is not a row projection — it is a fetch — so it
 * escaped that extraction and each read defaulted it to `[]` independently:
 *
 *   · `resolve-and-cache.ts` → what every surface ADVERTISES.
 *   · `window-availability.ts` → what a booking is ACCEPTED against.
 *
 * `apps/api/src/jobs/availability-cache.ts` records that BAL-396 wires Apiroc free/busy
 * "through this same call site" — the ADVERTISE one. Had the accept path kept its own `[]`,
 * that wiring would have silently stopped the booking gate honouring an expert's real
 * external commitments, and NOTHING would have failed: not a type, not a test, not a helper.
 * A shared literal would only have been a grep target. A shared PORT is a compile dependency:
 * there is one implementation, both paths call it, and BAL-396 replaces it once for both.
 *
 * ⚠ SO DO NOT RE-INLINE `[]` AT EITHER CALL SITE, and do not give this a second
 * implementation keyed on which caller is asking. If advertise and accept ever SHOULD read
 * different vendor busy (they should not), that is a product ruling that belongs in one
 * documented branch here, never in two files that drifted apart.
 *
 * ⚠ THE ONE PLACE A CALLER MAY STILL SUPPLY ITS OWN IS `ResolveAndCacheOptions.busyBlocks`,
 * and that override is SEED/TEST-ONLY — see its docblock in `./resolve-and-cache.ts` for the
 * divergence it deliberately accepts.
 *
 * ⚠ AND WHATEVER VENDOR LANDS HERE READS A WINDOW, NEVER A DELTA. ADR-1021's 2026-08-15
 * amendment (BAL-447) rules that a calendar-change webhook is a bare trigger enqueuing a
 * whole-window rebuild, uniformly — there is no per-vendor sync path and no delta cursor is
 * read or stored. The matrix, the evidence and the reasoning are in
 * `apps/api/src/services/calendar/sync-capability.ts`, which is INERT BY DESIGN: read it,
 * do not import it.
 *
 * ── BAL-396 §9 — THE BODY, AND ITS FAILURE SEMANTICS ────────────────────────────────────
 *
 * `listBusyReadTargets` returns `[]` for every expert with no Apiroc pointer (every expert on
 * the merge commit, since Apiroc rows can only be created by this ticket's callback), so the
 * merge commit is a BEHAVIOURAL NO-OP — the vendor client is never even constructed. Wiring
 * turns on per expert, at the moment they connect.
 *
 * ⚠⚠ AN UNREADABLE CONNECTION (`SYNC_PENDING` / `EXPIRED` / `REVOKED`, or provisioned with
 * zero sub-calendar rows) THROWS `VendorBusyUnavailableError` RATHER THAN RETURNING `[]`.
 * Returning `[]` would read as "this expert has no external commitments" — fail OPEN, and
 * double-book them in front of a paying client. The two callers each answer differently
 * (§9.4, ADR-1021 amendment 18 Aug 2026): `window-availability.ts` CATCHES the throw and
 * fails the booking gate CLOSED (`false`); `resolve-and-cache.ts` CATCHES it and SKIPS the
 * cache write, leaving last-known-good rather than overwriting it with an answer this could
 * not compute. Neither catch belongs here — this function's contract is "throw when the
 * answer cannot be trusted", not "decide what each caller does about it".
 *
 * ⚠ NO PROVIDER LITERAL, ANYWHERE IN THIS FILE. This directory is inside Scan B
 * (`invariants/sync-token-parity.test.ts`) — the parity table (apiroc skill) is handled by
 * PARSING every wire shape tolerantly (`toBusyBlocks`), never by branching on `provider`.
 */
import { calendarRepository, type CalendarCredentialStatus } from '@balo/db';
import type { FreeBusySlot } from '@apiroc/unified-calendar-api-node-sdk';
import { createLogger } from '@balo/shared/logging';
import { fromZonedTime } from 'date-fns-tz';
import { callApiroc, getApirocClient } from '../../lib/apiroc/index.js';
import type { BusyBlock } from './types.js';

const log = createLogger('vendor-busy');

/**
 * Thrown by the live provider when the answer cannot be trusted — an unreadable connection,
 * or a vendor read that failed. Callers MUST NOT treat this as "no busy blocks"; see the
 * failure-semantics table in this file's docblock (§9.4).
 */
export class VendorBusyUnavailableError extends Error {
  constructor(expertProfileId: string, detail: string) {
    super(`Vendor busy unavailable for expert ${expertProfileId}: ${detail}`);
    this.name = 'VendorBusyUnavailableError';
    Object.setPrototypeOf(this, VendorBusyUnavailableError.prototype);
  }
}

/**
 * The seam a calendar vendor plugs into. Mirrors the injectable-port precedent already in
 * this codebase (`RoomProvisioner` in `services/daily/rooms.ts`, `LlmClient` in
 * `services/transcript/llm/`): an interface plus one live object, so a future vendor lands
 * in a single file and every consumer picks it up at once.
 *
 * `[from, to)` is the range the caller needs answered — the advertise path asks about its
 * whole horizon, the accept path about one padded window. A vendor implementation MUST NOT
 * assume either shape.
 */
export interface VendorBusyProvider {
  listBusyBlocks(expertProfileId: string, from: Date, to: Date): Promise<BusyBlock[]>;
}

const READABLE_STATUS: CalendarCredentialStatus = 'ACTIVE';

/**
 * A connection whose read cannot be trusted — not `ACTIVE`, or `ACTIVE` with no sub-calendar
 * rows at all (never provisioned). Distinct from "provisioned but every sub-calendar has
 * `conflict_check = false`", which is a readable connection that simply contributes nothing
 * (the expert's explicit choice, §9.4) — that case is handled by the `calendarIds.length`
 * filter below, not by this predicate.
 */
function isUnreadable(target: {
  credentialStatus: CalendarCredentialStatus;
  provisioned: boolean;
}): boolean {
  return target.credentialStatus !== READABLE_STATUS || !target.provisioned;
}

/**
 * `EventDateTime.dateTime` is optional and provider-shaped (parity table: PARSE, NEVER
 * STRING-COMPARE — Google labels UTC `UTC` and emits `...:00Z`; Microsoft labels it `Etc/UTC`
 * and emits `...:00.000Z`).
 *
 * ⚠ round-2 fix #2 — the vendor's own field doc reads *"ISO 8601 format (e.g.
 * `2023-03-15T10:00:00`)"*, i.e. NO OFFSET is permitted by the shape, with the zone carried
 * in the sibling `timeZone` field. Per the ES spec a date-time string with no offset
 * designator parses as SERVER-LOCAL, not UTC — `new Date('2026-09-07T10:00:00')` on a
 * non-UTC host silently returns the wrong instant. Every observed response so far has carried
 * a trailing `Z` (`:00Z` / `:00.000Z`), but that is an observation, not a contract this file
 * may lean on. A `dateTime` with an explicit offset (`Z` or `±HH:MM`) is parsed directly;
 * a NAIVE `dateTime` is resolved through its sibling `timeZone` via `fromZonedTime`
 * (DST-correct, same primitive `resolver.ts` already uses); a naive `dateTime` with no
 * `timeZone` to resolve it against cannot be trusted and is treated as unparseable.
 */
const HAS_OFFSET_DESIGNATOR = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function parseInstant(dateTime: string | undefined, timeZone: string | undefined): Date | null {
  if (dateTime === undefined) return null;
  if (HAS_OFFSET_DESIGNATOR.test(dateTime)) {
    const parsed = new Date(dateTime);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (timeZone === undefined) return null;
  try {
    const parsed = fromZonedTime(dateTime, timeZone);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * Parsing one vendor `FreeBusySlot` (one calendar's worth). `droppedCount` is deliberately
 * surfaced rather than swallowed — round-2 fix #1: `BusySlot.start`/`end` and
 * `EventDateTime.dateTime` are all OPTIONAL BY TYPE, so a real commitment can arrive in an
 * unparseable shape, not just a corrupted one. Silently skipping it would make
 * `isWindowBookable` see the window as free and double-book the expert in front of a paying
 * client — the exact failure this file's docblock (§9.4) exists to prevent. The caller MUST
 * treat any `droppedCount > 0` as an untrustworthy read, same as any other unreadable
 * connection, and reject rather than answer with a partial set (`:202` — partial data is not
 * an answer).
 */
function toBusyBlocks(slot: FreeBusySlot): { blocks: BusyBlock[]; droppedCount: number } {
  const blocks: BusyBlock[] = [];
  let droppedCount = 0;
  for (const raw of slot.busySlots ?? []) {
    const startAt = parseInstant(raw.start?.dateTime, raw.start?.timeZone);
    const endAt = parseInstant(raw.end?.dateTime, raw.end?.timeZone);
    if (startAt === null || endAt === null || endAt <= startAt) {
      droppedCount += 1;
      continue;
    }
    blocks.push({ startAt, endAt });
  }
  return { blocks, droppedCount };
}

/**
 * One vendor call, one account. `callApiroc`'s ONE-fallible-call contract (`lib/apiroc/
 * index.ts`) is honoured by construction: this wraps exactly `freeBusy.get`, and the fan-out
 * across accounts below is `Promise.allSettled` over SEPARATE `callApiroc` invocations, never
 * a `Promise.all` wrapped inside one.
 */
async function fetchBusyForTarget(
  target: { endUserAccountId: string; calendarIds: string[] },
  from: Date,
  to: Date
): Promise<BusyBlock[]> {
  const slots = await callApiroc('freeBusy.get', () =>
    getApirocClient().freeBusy.get(target.endUserAccountId, {
      startDateTime: from,
      endDateTime: to,
      timeZone: 'UTC',
      calendarIds: target.calendarIds,
    })
  );

  const parsed = slots.map(toBusyBlocks);
  const droppedCount = parsed.reduce((sum, p) => sum + p.droppedCount, 0);
  if (droppedCount > 0) {
    log.warn(
      { endUserAccountId: target.endUserAccountId, droppedCount },
      'apiroc_busy_read_unparseable_slot'
    );
    // Caught by the Promise.allSettled rejection handling below, which already turns any
    // rejected vendor read into VendorBusyUnavailableError — partial data is not an answer.
    throw new Error(
      `${droppedCount} unparseable busy slot(s) for account ${target.endUserAccountId}`
    );
  }
  return parsed.flatMap((p) => p.blocks);
}

/**
 * THE LIVE IMPLEMENTATION — BAL-396 §9. See this file's top docblock for the failure
 * semantics; `window-availability.ts` and `resolve-and-cache.ts` each catch
 * `VendorBusyUnavailableError` and decide what to do about it (fail closed / skip the write).
 */
export const vendorBusyProvider: VendorBusyProvider = {
  async listBusyBlocks(expertProfileId: string, from: Date, to: Date): Promise<BusyBlock[]> {
    const targets = await calendarRepository.listBusyReadTargets(expertProfileId);
    if (targets.length === 0) {
      // ⚠ BEFORE ANY SDK CONSTRUCTION. §9.3 — an unset `APIROC_API_KEY` must not be able to
      // throw `ApirocConfigError` into the booking path for an expert with no connection at
      // all (every expert, on the merge commit).
      return [];
    }

    // ⚠ round-2 fix #5 — apply the "contributes nothing" filter FIRST, before computing
    // `unreadable`, not after. A PROVISIONED connection with no conflict-checked calendar is
    // the expert's explicit choice (§9.4) and its data is irrelevant regardless of whether its
    // credential later expires — an expert with one healthy connection and a second they
    // deliberately opted every calendar out of must not go entirely unbookable the moment
    // that second credential expires. An UNPROVISIONED connection is never excluded here even
    // though its `calendarIds` is also `[]` structurally — Balo has never listed its
    // calendars, so we don't know what conflict-checked calendars might be hidden there, and
    // it must still be checked below.
    const consideredTargets = targets.filter((t) => !t.provisioned || t.calendarIds.length > 0);

    const unreadable = consideredTargets.filter(isUnreadable);
    if (unreadable.length > 0) {
      log.warn(
        {
          expertProfileId,
          unreadableConnectionIds: unreadable.map((t) => t.connectionId),
          statuses: unreadable.map((t) => t.credentialStatus),
        },
        'apiroc_busy_read_unreadable_connection'
      );
      throw new VendorBusyUnavailableError(
        expertProfileId,
        `${unreadable.length} connection(s) not readable`
      );
    }

    // Every remaining target is provisioned, ACTIVE, and has at least one conflict-checked
    // calendar — safe to fan out.
    const results = await Promise.allSettled(
      consideredTargets.map((t) => fetchBusyForTarget(t, from, to))
    );

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (rejected.length > 0) {
      log.warn(
        {
          expertProfileId,
          failedCount: rejected.length,
          totalCount: consideredTargets.length,
          errors: rejected.map((r) =>
            r.reason instanceof Error ? r.reason.message : String(r.reason)
          ),
        },
        'apiroc_busy_read_partial_failure'
      );
      // Partial data is not an answer — see this file's failure-semantics docblock.
      throw new VendorBusyUnavailableError(expertProfileId, 'one or more vendor reads failed');
    }

    return results.flatMap((r) => (r as PromiseFulfilledResult<BusyBlock[]>).value);
  },
};
