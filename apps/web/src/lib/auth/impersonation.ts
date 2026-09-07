import 'server-only';

import { log } from '@/lib/logging';
import type { SessionUser } from './session';

/**
 * BAL-528 — THE ONE DEFINITION of "this session is impersonated". Never re-derive it; never write
 * `user.isImpersonating === true` anywhere else. `invariants/impersonation-money-guard.test.ts`
 * enforces that mechanically (same rule shape as `relationshipDeniesHosting` in
 * `@balo/shared/authz` — one predicate, one home).
 *
 * ⚠ `=== true`, NOT truthiness. The field is optional (`isImpersonating?: boolean`) and absent on
 * every session sealed before the impersonation feature exists, so a loose check would be a
 * different (and looser) predicate the moment the field ever carried a non-boolean.
 */
export function isImpersonatedSession(actor: Pick<SessionUser, 'isImpersonating'>): boolean {
  return actor.isImpersonating === true;
}

/**
 * Whether a gate that admits both mutations and reads should REFUSE under impersonation.
 * Defaults to refusal at every consumer; the permissive value is only ever named explicitly, at a
 * call site that is documented as a READ. Deliberately a named string literal rather than a
 * boolean, for the same reason `CardBackedModeWriteGuard` is: the exemption must be greppable, and
 * a source-scan invariant counts its occurrences.
 *
 * `billing_read_permitted_under_impersonation` implements the skill's own allow-list
 * (`references/webhooks-sessions.md:292-297`: "viewing billing history" is permitted).
 */
export type ImpersonationGuard =
  | 'refuse_under_impersonation'
  | 'billing_read_permitted_under_impersonation';

/**
 * The refusal log line. Exported as a constant so the helper and its tests can never drift apart
 * on the string. (This is NOT an Axiom-monitor string — no monitor matches it, and none is in
 * scope for BAL-528. If a monitor is ever built on it, the verbatim-pin obligation applies then.)
 */
export const IMPERSONATION_REFUSAL_MESSAGE =
  'Destructive money action refused — impersonated session';

/**
 * What a refusal names: the specific action refused, the company it was refused for, and the
 * actor who attempted it. `actorUserId` is REQUIRED, not optional — see the function docblock
 * below for why it cannot be inferred from ambient request context here.
 */
export interface ImpersonationRefusalContext {
  readonly action: string;
  readonly companyId: string;
  readonly actorUserId: string;
}

/**
 * `true` when `actor` is impersonating and the caller must therefore refuse this destructive money
 * action — emitting exactly ONE `log.warn` as it does. `false`, and silent, for a normal session:
 * an ordinary money action must not produce a log line, and the two exempt READS are polled ~13×
 * per receipt.
 *
 * ⚠ WARN, NOT ERROR. A refused policy outcome is not a system fault, and the sibling refusals on
 * this same surface all warn ('Low-balance disarm refused …', 'Card-backed low-balance mode refused
 * …', 'Card change refused …'). `log.error` would page on a seatbelt working correctly.
 *
 * ⚠ THE PAYLOAD IS `action` + `companyId` + `actorUserId` AND NOTHING ELSE — never a token, never
 * the session, never an email or card fact, the same discipline `removeSavedCardAction`'s catch
 * documents. `actorUserId` is passed explicitly by every caller (never inferred here): apps/web has
 * no application call site of `withContext()` today, so the pino AsyncLocalStorage mixin
 * (`lib/logging/index.ts`) has no request context to attach a `userId` from on this path, and this
 * line is the sole server-side record of WHO attempted a blocked money action while impersonating —
 * it must not identify only a company. Sibling code in this same surface already threads the same
 * field the same way (`redeem-promo.ts`'s `actorUserId: user.id`).
 *
 * ⚠ THIS IS A REFUSAL, AND IT IS NOT THE ONLY VALID RESPONSE TO IMPERSONATION.
 * `lib/actions/expert-checklist.ts` deliberately does the opposite — it ANNOTATES the audit row and
 * lets the write proceed (refusing there would leave `searchable` stale). Do not "align" the two:
 * they answer different questions. That call site uses {@link isImpersonatedSession} only.
 */
export function refuseMoneyActionUnderImpersonation(
  actor: Pick<SessionUser, 'isImpersonating'>,
  context: ImpersonationRefusalContext
): boolean {
  if (!isImpersonatedSession(actor)) return false;
  log.warn(IMPERSONATION_REFUSAL_MESSAGE, context);
  return true;
}
