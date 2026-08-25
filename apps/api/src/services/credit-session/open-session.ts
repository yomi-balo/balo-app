/**
 * BAL-378 (ADR-1040 Lane 2) — `openSession`: resolve the acting member's billing company + wallet,
 * gate CONSUME_CREDITS (company-scoped, fail-closed), then delegate to the repo's atomic
 * gate+hold+create-pending primitive. Thin — all money/rate logic lives in `@balo/db`.
 *
 * BAL-401 — removes the silent "first membership" inference: the service builds the member's
 * ELIGIBLE billing-company set (memberships holding CONSUME_CREDITS) and either honours an explicit
 * (capability-gated) `companyId`, auto-selects the single eligible company, or returns
 * `company_selection_required` when more than one is eligible and none was chosen.
 */
import {
  creditSessionsRepository,
  creditWalletsRepository,
  engagementsRepository,
  meetingsRepository,
  usersRepository,
} from '@balo/db';
import { CAPABILITIES, roleHasCapability } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import type { EligibleCompany } from '@balo/shared/credit';
import type { OpenSessionServiceInput, OpenSessionServiceResult } from './types.js';

const log = createLogger('credit-session');

/**
 * The acting member's CONSUME_CREDITS-eligible billing companies, projected narrow
 * ({id,name,logoUrl}) from their LIVE company memberships. Reuses `findWithCompany`
 * (deterministic, soft-delete filtered) — NO new repo method, and NO per-company wallet
 * lookup (wallet resolution stays keyed off the single chosen companyId). The narrow
 * projection is load-bearing: it stops company internals (creditBalance / isPersonal)
 * reaching the client.
 */
async function resolveEligibleCompanies(userId: string): Promise<EligibleCompany[]> {
  const user = await usersRepository.findWithCompany(userId);
  const memberships = user?.companyMemberships ?? [];
  const eligible: EligibleCompany[] = [];
  for (const m of memberships) {
    if (!roleHasCapability(m.role, CAPABILITIES.CONSUME_CREDITS)) continue;
    const { company } = m; // company_members.companyId is a NOT NULL FK ⇒ relation hydrates
    eligible.push({ id: company.id, name: company.name, logoUrl: company.logoUrl });
  }
  return eligible;
}

/**
 * BAL-129 (D5) — resolve the `engagements.id` a `meetingId` bills, SERVER-SIDE, from the
 * meeting alone. `undefined` ⇒ the caller must return `meeting_not_bookable`.
 *
 * ⚠ THE TWO EQUALITY CHECKS ARE NOT BELT-AND-BRACES ON TOP OF AN OWNERSHIP LOOKUP — THEY
 * ARE THE OWNERSHIP LOOKUP, AND THERE MUST NOT BE A SECOND ONE.
 *   · `chosenCompanyId` is ALREADY PROVEN: `openSession` only reaches this point having
 *     confirmed the caller holds `CONSUME_CREDITS` on that company.
 *   · `expertProfileId` came from the REQUEST BODY.
 * Requiring the meeting's engagement to name BOTH means an attacker who guesses or scrapes
 * a stranger's `meetingId` gets `meeting_not_bookable` — the meeting resolves to an
 * engagement whose company they hold no capability on. A separate "does this user own this
 * meeting?" check would be a SECOND place the pair could diverge, which is exactly the
 * failure `OpenSessionInput`'s docblock warns about: a divergent pair bills one engagement
 * while BAL-425's sweep, which resolves through the seam, ages out another.
 *
 * ⚠ MEETING STATUS IS NOT CHECKED. `findWithContexts` filters soft-deleted rows; that is the
 * only liveness requirement. A session may legitimately be opened for a meeting in
 * `scheduled` OR `waiting_for_participants`, and adding a status guard here would import
 * BAL-134's lifecycle (which has not landed) into the money path.
 *
 * ⚠ ENGAGEMENT STATUS **IS** CHECKED, AND THAT IS NOT A CONTRADICTION OF THE LINE ABOVE. The
 * MEETING lifecycle is BAL-134's and unbuilt; the ENGAGEMENT lifecycle is shipped and its enum
 * is exactly `active | completed | cancelled` (`schema/enums.ts`), so there is no legitimate
 * non-`active` billable state. Without this, a `completed` case — written by
 * `caseEngagementsRepository.close()` and never cleared — would remain a permanent handle for
 * drawing down credits and blocking that expert's calendar. Mirrors the identical guard in
 * `services/meetings/authorize-meeting-booking.ts`, so what may be BOOKED and what may be
 * BILLED cannot disagree about a closed engagement.
 */
async function resolveEngagementForMeeting(
  meetingId: string,
  chosenCompanyId: string,
  expertProfileId: string
): Promise<string | undefined> {
  const found = await meetingsRepository.findWithContexts(meetingId); // live rows only
  if (found === undefined) {
    return undefined;
  }

  const caseContexts = found.contexts.filter((c) => c.contextType === 'case');
  const [caseContext] = caseContexts; // destructure + guard, never `!`
  if (caseContext === undefined || caseContexts.length !== 1 || caseContext.contextId === null) {
    return undefined;
  }

  const engagement = await engagementsRepository.findById(caseContext.contextId);
  if (
    engagement === undefined ||
    engagement.engagementType !== 'case' ||
    engagement.status !== 'active' || // ← a closed case is not a billing handle
    engagement.companyId !== chosenCompanyId || // ← IDOR gate
    engagement.expertProfileId !== expertProfileId // ← IDOR gate
  ) {
    return undefined;
  }
  return engagement.id;
}

/**
 * Step 2 of `openSession` — resolve the billing company from the eligible set, honouring an
 * explicit (capability-gated) `companyId`, auto-selecting the single eligible company, or
 * signalling `company_selection_required` when more than one is eligible and none was chosen.
 * Extracted purely to keep `openSession`'s own cognitive complexity under the SonarCloud gate —
 * no behavioural change from the inline version.
 */
function resolveChosenCompany(
  eligible: EligibleCompany[],
  companyId: string | undefined,
  initiatingMemberId: string
): { ok: true; companyId: string } | { ok: false; result: OpenSessionServiceResult } {
  if (companyId !== undefined) {
    // Explicit choice MUST be one the caller holds CONSUME_CREDITS on (fail-closed IDOR guard).
    const match = eligible.find((c) => c.id === companyId);
    if (match === undefined) {
      log.warn(
        { userId: initiatingMemberId, companyId },
        'openSession denied — companyId not in eligible set'
      );
      return { ok: false, result: { ok: false, code: 'forbidden' } };
    }
    return { ok: true, companyId: match.id };
  }

  if (eligible.length === 1) {
    const [only] = eligible;
    if (only === undefined) return { ok: false, result: { ok: false, code: 'forbidden' } }; // unreachable; satisfies noUncheckedIndexedAccess
    return { ok: true, companyId: only.id };
  }

  log.info(
    { userId: initiatingMemberId, count: eligible.length },
    'openSession — company selection required'
  );
  return {
    ok: false,
    result: { ok: false, code: 'company_selection_required', companies: eligible },
  };
}

export async function openSession(
  input: OpenSessionServiceInput
): Promise<OpenSessionServiceResult> {
  const { initiatingMemberId, expertProfileId, estimatedMinutes, companyId, meetingId } = input;

  // BAL-466 (D4) — COHERENCE. A `'presence'` session settles from `meeting_presence`, which is
  // meeting-grained; `findPresenceUnsettled` requires `meeting_id IS NOT NULL`. Opening one
  // without a meeting would produce a row that NO settlement path can ever reach.
  if (input.durationSource === 'presence' && meetingId === undefined) {
    log.error(
      { userId: initiatingMemberId, expertProfileId },
      'openSession refused — presence provenance requires a meetingId'
    );
    return { ok: false, code: 'meeting_not_bookable' };
  }

  // 1. Build the member's CONSUME_CREDITS-eligible billing-company set (subsumes the old
  //    findWithCompany + getMemberRole gate: membership ∈ eligible IS the capability check).
  const eligible = await resolveEligibleCompanies(initiatingMemberId);

  // No eligible company (no membership / lacks CONSUME_CREDITS) → fail closed.
  if (eligible.length === 0) {
    log.info({ userId: initiatingMemberId }, 'openSession denied — no CONSUME_CREDITS company');
    return { ok: false, code: 'forbidden' };
  }

  // 2. Resolve the chosen billing company.
  const chosen = resolveChosenCompany(eligible, companyId, initiatingMemberId);
  if (!chosen.ok) {
    return chosen.result;
  }
  const chosenCompanyId = chosen.companyId;

  // 2b. BAL-129 (D5) — resolve the billed engagement from the meeting, if one was supplied.
  //     Placed AFTER the eligible-company resolution and BEFORE the wallet lookup, so
  //     `chosenCompanyId` is already capability-gated when the equality check runs.
  let resolvedEngagementId: string | undefined;
  if (meetingId !== undefined) {
    resolvedEngagementId = await resolveEngagementForMeeting(
      meetingId,
      chosenCompanyId,
      expertProfileId
    );
    if (resolvedEngagementId === undefined) {
      // WHICH of the six shapes it was goes to the log, never to the wire.
      log.warn(
        { userId: initiatingMemberId, companyId: chosenCompanyId, meetingId, expertProfileId },
        'openSession denied — meetingId does not resolve to a billable case engagement'
      );
      return { ok: false, code: 'meeting_not_bookable' };
    }
  }

  // 3. Resolve the company wallet (one-per-company; the mandate rides on the wallet row).
  const wallet = await creditWalletsRepository.findByCompanyId(chosenCompanyId);
  if (wallet === undefined) {
    log.error({ companyId: chosenCompanyId }, 'openSession — company has no credit wallet');
    return { ok: false, code: 'wallet_missing' };
  }

  // 4. Delegate to the atomic gate + hold + create-pending primitive.
  const result = await creditSessionsRepository.open({
    walletId: wallet.id,
    companyId: chosenCompanyId,
    expertProfileId,
    initiatingMemberId,
    estimatedMinutes,
    // BOTH or NEITHER, from the SINGLE resolution above — never one without the other, and
    // never an `engagementId` the client supplied. Conditionally spread so a call with no
    // meeting is byte-identical to the pre-BAL-129 one (and `exactOptionalPropertyTypes`-safe).
    ...(meetingId === undefined || resolvedEngagementId === undefined
      ? {}
      : { meetingId, engagementId: resolvedEngagementId }),
    // BAL-466 (D4) — omitted ⇒ the repository's `'live_capture'` default, so every
    // pre-BAL-466 call site is byte-identical.
    ...(input.durationSource === undefined ? {} : { durationSource: input.durationSource }),
  });

  if (!result.ok) {
    log.info(
      { companyId: chosenCompanyId, walletId: wallet.id, code: result.code },
      'openSession gate rejected'
    );
    return { ok: false, code: result.code };
  }

  log.info(
    {
      sessionId: result.session.id,
      companyId: chosenCompanyId,
      walletId: wallet.id,
      estimatedMinutes,
    },
    'Session opened (pending)'
  );
  return {
    ok: true,
    sessionId: result.session.id,
    status: 'pending',
    holdId: result.session.holdId,
  };
}
