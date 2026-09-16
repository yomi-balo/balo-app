import { platformActorHasCapability, type PlatformCapability } from '@balo/shared/authz';

/**
 * BAL-560 / ADR-1035 — the `apps/api` platform-capability seam. Mirror of
 * `apps/web/src/lib/authz/platform.ts` over the SAME pure core, differing in ONE thing, and
 * that difference is DELIBERATE AND PERMANENT (D6) — do not "fix" it as drift:
 *
 *   · `apps/web` resolves from the SEALED SESSION. It must: `middleware.ts` runs on the EDGE
 *     runtime, where `invariants/middleware-admin-capability-gated.test.ts` pins that the file
 *     imports no `server-only`, no `@balo/db` and no `node:` — a live read there is
 *     structurally impossible — and 48 production call sites depend on the seam being
 *     synchronous.
 *   · `apps/api` resolves from a LIVE `usersRepository.findById` ROW, and says so in its own
 *     words at `routes/admin/index.ts`: "NEVER a cookie-carried role — the cookie's
 *     `platformRole` can be stale". A demoted staff member must lose access the moment their
 *     row changes.
 *
 * ⚠⚠ ENFORCEMENT LATENCY, STATED HONESTLY (fix round 1, security F2). An earlier version of this
 * paragraph said a revoked override is enforced on `apps/web` "at the next drift-sync", which
 * over-promised. The truth:
 *   · `apps/api` — enforced IMMEDIATELY. Every gate re-reads the row.
 *   · `apps/web` PAGE RENDERS — enforced at the next render, because `checkSessionDrift` runs
 *     there and the sync route repatches the cookie.
 *   · `apps/web` SERVER ACTIONS — **NOT enforced by drift at all.** A Server Action POSTs
 *     straight to its own endpoint; no render happens first, so `checkSessionDrift` never runs
 *     and the action reads whatever the cookie was sealed with, for up to seven days. Mutating,
 *     capability-gated Server Actions therefore re-read the actor themselves (the precedent is
 *     the impersonation entry point, `apps/web/src/lib/auth/actions/impersonation.ts`). Any that
 *     do NOT are cookie-stale by construction — see the PR body for the list BAL-558 inherits.
 */
export interface PlatformCapabilityActor {
  readonly platformRole: string;
  /**
   * The stored override, exactly as `users.platform_capabilities` is typed by the repository.
   *
   * ⚠ REQUIRED, not optional, on purpose: a caller holding only a role STRING cannot satisfy
   * this type, which is what forces `resolveAdminMoneyBlock` to take the actor rather than keep
   * its bare `platformRole: string` (D11) instead of silently resolving without the override.
   *
   * ⚠⚠ AND `PlatformCapability[] | null`, NOT `unknown` (fix round 1, security F5). `unknown`
   * admits `undefined`, so `{ platformRole: user.platformRole, platformCapabilities: undefined }`
   * type-checked — a caller could satisfy the "required" field without supplying a real value and
   * silently resolve a fee-blind admin as a FULL admin on the MONEY gate. That is precisely the
   * bypass the requiredness exists to prevent, so the type has to exclude it rather than merely
   * ask for a property name. A repository row satisfies this as-is; `undefined` no longer does.
   *
   * ⚠ THE RUNTIME STILL TREATS IT AS UNTRUSTED. `$type<PlatformCapability[]>()` on a jsonb column
   * is a compile-time claim Postgres does not enforce, so this narrowing buys a CALLER guarantee,
   * not a data guarantee. `platformActorHasCapability` takes `unknown` and normalises a non-array
   * to "inherit"; the seam deliberately does not re-narrow or assert on the value.
   */
  readonly platformCapabilities: PlatformCapability[] | null;
}

/**
 * True when this actor's platform role AND per-user override grant `capability`.
 *
 * A full `User` row from `usersRepository.findById` satisfies `PlatformCapabilityActor`
 * structurally — no cast, and no projection change was needed anywhere (D6).
 */
export function userHasPlatformCapability(
  actor: PlatformCapabilityActor,
  capability: PlatformCapability
): boolean {
  return platformActorHasCapability(actor.platformRole, actor.platformCapabilities, capability);
}
