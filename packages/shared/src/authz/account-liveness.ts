import { userRowIsLive } from './staff-access';

/**
 * BAL-568 (ruling 2026-09-18) — **THE ONE PLACE THE TWO ACCOUNT-REFUSAL CODES ARE CHOSEN**, on
 * all three enforcement paths (page render, `apps/api` Bearer call, `apps/web` Server Action).
 *
 * ⚠⚠ IT IS BUILT **ON** {@link userRowIsLive}, NOT A SECOND DEFINITION OF "LIVE". The predicate
 * `deleted_at IS NULL AND status = 'active'` already exists and is already exported
 * (`./staff-access.ts`); this module adds only the CODE SELECTION on top of it. This repo has a
 * standing rule against a second definition of a shared predicate (cf. `relationshipDeniesHosting`,
 * `actorHasExpertSideVisibility`) — `account-liveness.test.ts` pins that this file never restates
 * the conditions.
 *
 * ⚠ "DELETED" IS NOT A STATUS. The enum is `['active','inactive','suspended']`; deletion lives on
 * `deleted_at`. `inactive` refuses identically to `suspended` — the ticket names only the latter,
 * but the predicate does not distinguish them and neither may this.
 */

/**
 * The wire marker an `apps/api` 401 carries when the refusal is an ACCOUNT-STATE refusal rather
 * than an ordinary authentication failure. Lower-case: Fastify/undici normalise header names.
 *
 * ⚠ THE 401 **BODY** STAYS BYTE-IDENTICAL (`{"error":"Unauthorized"}`) — the marker is a response
 * HEADER, and that is the whole reconciliation between the ticket's "byte-identical 401" and the
 * ruling's "explicit, non-guessable marker". Reaching the arm that sets it requires presenting a
 * cryptographically valid WorkOS JWT whose `sub` resolves to that very account, so it discloses
 * the caller's own account state TO THE CALLER — exactly what `/login?error=account_suspended`
 * already discloses on the page path (BAL-197). Nothing about a third party is enumerable.
 *
 * Every reader today is server-side (`apps/web`'s `lib/auth/api-account-refusal.ts`, via
 * `lib/api/balo-api-client.ts`), where CORS does not apply. `apps/api/src/app.ts` still lists it
 * in the CORS `exposedHeaders` so that any browser-side reader could see it cross-origin
 * (`:3000` → `:3002`) instead of having it silently stripped.
 */
export const ACCOUNT_REFUSAL_HEADER = 'x-balo-session-invalid';

/** The two codes `apps/web/src/app/(auth)/login/page.tsx` already renders. Never a third. */
export type AccountRefusalCode = 'account_suspended' | 'account_deleted';

/** The Pino/PostHog vocabulary `app/api/auth/session-sync/route.ts` already writes. */
export type AccountRefusalReason = 'suspended' | 'deleted';

/** The two columns liveness is decided from — the exact shape {@link userRowIsLive} reads. */
export interface AccountLivenessRow {
  readonly status: string;
  readonly deletedAt: Date | null;
}

/**
 * `null` ⇒ the account is live and may act. Otherwise the refusal code, in the SAME PRECEDENCE
 * `apps/web/src/app/api/auth/session-sync/route.ts` has always used: a MISSING row and a
 * soft-deleted row both read `account_deleted`; only a present, non-deleted, non-`active` row
 * reads `account_suspended`.
 *
 * ⚠ THE PRECEDENCE MATTERS AND IS PINNED. A row that is BOTH suspended and soft-deleted reads
 * `account_deleted`, because that is the order the shipped route branches in and BAL-197's copy
 * was written against it. Checking `status` first would regress shipped copy for exactly that row.
 *
 * ⚠ IT ACCEPTS `undefined` AS WELL AS `null`, DELIBERATELY. Repository reads in this codebase
 * differ on which absent-row sentinel they return (`findFirst` yields `undefined`, the explicit
 * projections yield `null`). A nullish row must REFUSE, not throw: a `TypeError` raised inside
 * `requireAuth` or `getCurrentUser` would surface as a 500 rather than a refusal, which is the
 * wrong direction for a fail-closed security predicate to be wrong in.
 */
export function classifyAccountRefusal(
  row: AccountLivenessRow | null | undefined
): AccountRefusalCode | null {
  if (row === null || row === undefined) return 'account_deleted';
  if (userRowIsLive(row)) return null;
  // ⚠ THE POSITIVE BRANCH LEADS (SonarCloud S7735 / `unicorn/no-negated-condition`), but the
  // PRECEDENCE is unchanged and is what matters: a soft-deleted row reads `account_deleted`
  // whatever its `status` says.
  return row.deletedAt === null ? 'account_suspended' : 'account_deleted';
}

/** The log/analytics word for a refusal code. */
export function reasonOfRefusal(code: AccountRefusalCode): AccountRefusalReason {
  return code === 'account_deleted' ? 'deleted' : 'suspended';
}

/**
 * Whether an arbitrary value — a response header, say — is one of the two codes. Fails closed on
 * anything else, including a case variant: the wire value is lower-case by construction.
 */
export function isAccountRefusalCode(value: unknown): value is AccountRefusalCode {
  return value === 'account_suspended' || value === 'account_deleted';
}
