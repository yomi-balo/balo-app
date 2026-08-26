import 'server-only';

import {
  meetingContextsRepository,
  meetingsRepository,
  partyMembershipsRepository,
  resolveMeetingContextOwner,
  type Meeting,
} from '@balo/db';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import {
  resolveMeetingParticipation,
  type MeetingParticipationDenialReason,
  type MeetingParticipationOk,
  type MeetingParticipationReads,
  type MeetingParticipationSide,
  type PrimaryMeetingContext,
} from '@balo/shared/meetings';
import { hasEngagementCapability } from '@/lib/authz/engagement';
import { log } from '@/lib/logging';

/**
 * BAL-466 (D3) — the `apps/web` wrapper over the ONE participation rule.
 *
 * ⚠⚠ IT IS A THIN FETCH-AND-CALL WRAPPER, NOT A SECOND DEFINITION. The rule lives in
 * `@balo/shared/meetings`'s `resolveMeetingParticipation`, shared with `apps/api`'s
 * `authorize-meeting-participation.ts`. If you find yourself writing `role === 'owner'`, a
 * precedence table, or a second owning-party switch in this file, stop — the rule is not here
 * and must not become so.
 *
 * ⚠ ITS ONE CONSUMER IS `resolveInCallDrawdown`. It is deliberately NOT a general web
 * participation seam yet; a second consumer should re-read the engagement-arm note below
 * before adopting it.
 *
 * ⚠ NOTHING HERE AUTHORIZES A MONEY READ ON ITS OWN. A `true` says "this actor takes part in
 * this meeting". The in-call drawdown gate ALSO requires live membership of
 * `credit_sessions.company_id` — an independent FK column — and that second read is what keeps
 * the delivering expert away from the client's funding state (D10). Do not drop it.
 *
 * ⚠⚠ LOCATION MATTERS. This module must NOT move into `apps/web/src/lib/meetings/` — that
 * directory is scanned by `meeting-call-no-lens-gate.test.ts` through the `CALL_LIB_FILES`
 * allow-list, and that suite bans the substring `hasEngagementCapability` across the
 * call-surface trees. `apps/web/src/lib/authz/` is scanned by no structural suite.
 */
export type { MeetingParticipationSide };

/**
 * ⚠⚠ F16 (review fix round) — THE `ok: true` ARM IS `MeetingParticipationOk<Meeting>`, NOT A
 * HAND-RESTATED COPY. `apps/api`'s `authorize-meeting-participation.ts` composes the identical
 * shared shape — see `@balo/shared/meetings`'s docblock on `MeetingParticipationOk` for why this
 * is one definition rather than two.
 */
export type AuthorizeMeetingParticipationResult =
  | ({ ok: true } & MeetingParticipationOk<Meeting>)
  /** ⚠ ONE literal. There is deliberately no `forbidden`. */
  | { ok: false; code: 'meeting_not_found' };

/**
 * ⚠⚠ THE ENGAGEMENT ARM ON THIS APP IS **TOTAL BUT NOT COMPLETE**, AND THAT IS A DECISION.
 *
 * `apps/web`'s engagement resolver (`lib/authz/engagement.ts`, opened by BAL-421) is NARROWED
 * BY TYPE to the four ENGAGEMENT-GRAIN labels; ADR-1046's amendment records that widening it to
 * the request-grain arms is BAL-410 / BAL-411's work. This switch is therefore TOTAL over the
 * six holder-bearing labels — a seventh breaks `pnpm --filter web check-types` right here — but
 * the two request-grain arms answer `false` rather than resolving.
 *
 * ⚠ WHY THAT IS SAFE AT THIS CONSUMER, PROVEN RATHER THAN ASSERTED: the engagement arm can only
 * ever resolve an EXPERT-SIDE actor, and `resolveInCallDrawdown`'s third step
 * (`getSessionDrawdownState`) requires LIVE MEMBERSHIP OF `credit_sessions.company_id` — which
 * no expert-side actor holds. So on this path the arm's answer cannot change the outcome for
 * ANY actor, on ANY context label: a `true` would be denied one step later. Pinned by
 * `meeting-participation.test.ts`'s "the expert side is denied even when the gate authorizes it".
 *
 * ⚠ IT IS FAIL-CLOSED, AND IT IS NOT LOGGED. An ordinary "not a holder" is a normal answer to a
 * normal question (`authorize-engagement-host.ts` states the same rule); logging it would write
 * a line per call-page render for every expert on a discovery call. The DENIAL is logged once,
 * by the wrapper's `deny`.
 *
 * ⚠ A SECOND CONSUMER MUST RE-READ THIS. If a future web caller needs the expert arm to be
 * RIGHT rather than merely harmless, widen `lib/authz/engagement.ts` (BAL-410 / BAL-411) — do
 * not special-case it here.
 */
async function holdsMeetingEngagementCapability(
  userId: string,
  subject: PrimaryMeetingContext
): Promise<boolean> {
  switch (subject.contextType) {
    case 'case':
    case 'project_kickoff':
    case 'package_session':
    case 'retainer_checkin':
      return hasEngagementCapability({ id: userId }, ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT, {
        contextType: subject.contextType,
        contextId: subject.contextId,
      });
    case 'project_discovery':
    case 'request_interaction':
      return false;
    default: {
      // A SEVENTH holder-bearing `meeting_context_type` label stops `check-types` HERE.
      const exhaustive: never = subject.contextType;
      log.warn('Unhandled meeting context type in the web engagement arm — failing closed', {
        contextType: exhaustive as string,
      });
      return false;
    }
  }
}

const PARTICIPATION_READS = {
  findMeeting: (meetingId: string) => meetingsRepository.findById(meetingId),
  listMeetingContexts: (meetingId: string) => meetingContextsRepository.listByMeeting(meetingId),
  // ⚠ `@balo/db`'s ready-bound resolver — the SAME core `apps/api`'s `loadOwningParty`
  // delegates to. `authorize-meeting-file-access.ts` already uses exactly this function.
  resolveOwner: resolveMeetingContextOwner,
  findCompanyMemberRole: (companyId: string, userId: string) =>
    partyMembershipsRepository.getMemberRole('company', companyId, userId),
  holdsEngagementCapability: holdsMeetingEngagementCapability,
} satisfies MeetingParticipationReads<Meeting>;

/**
 * ⚠⚠ G2 (second review round) — CONTEXT LABELS THE WEB ENGAGEMENT ARM NEVER RESOLVES. A
 * `cross_tenant` denial on one of these is the EXPECTED shape for a delivering expert's own
 * discovery / request-interaction call — see `holdsMeetingEngagementCapability` above — never a
 * genuine cross-tenant attempt. Log level only; never touch authorization here.
 */
const UNIMPLEMENTED_ENGAGEMENT_ARM_CONTEXTS: ReadonlySet<string> = new Set([
  'project_discovery',
  'request_interaction',
]);

/**
 * The single fail-closed exit. The SHAPE goes to the log; the wire gets one literal.
 *
 * ⚠⚠ G2 (second review round) — LOG LEVEL, NOT AUTHORIZATION. `resolveBalanceSlot`
 * (`call/page.tsx`) runs `authorizeMeetingParticipation` for EVERY viewer on EVERY call-page
 * render (D8 runs authorization first), so a `cross_tenant` denial for a delivering expert on
 * their own `project_discovery` / `request_interaction` call — the two context labels
 * `holdsMeetingEngagementCapability` deliberately never resolves — fires on every render of a
 * page that expert visits legitimately every day. `apps/api` reserves `warn` for a genuine
 * cross-tenant access attempt; that is what Axiom should page on, and drowning it in the
 * expected shape defeats the alarm. Downgraded to `info` for exactly that shape; every other
 * `cross_tenant` denial (and every other reason) still `warn`s. Do NOT restore this to
 * unconditional `warn` "for consistency" — see G2's write-up.
 */
function deny(
  reason: MeetingParticipationDenialReason,
  fields: Readonly<Record<string, string | number | null>>
): { ok: false; code: 'meeting_not_found' } {
  const isExpectedCrossTenant =
    reason === 'cross_tenant' &&
    typeof fields.contextType === 'string' &&
    UNIMPLEMENTED_ENGAGEMENT_ARM_CONTEXTS.has(fields.contextType);
  if (isExpectedCrossTenant) {
    log.info('Meeting participation denied', { ...fields, reason });
  } else {
    log.warn('Meeting participation denied', { ...fields, reason });
  }
  return { ok: false, code: 'meeting_not_found' };
}

export async function authorizeMeetingParticipation(input: {
  meetingId: string;
  userId: string;
}): Promise<AuthorizeMeetingParticipationResult> {
  const result = await resolveMeetingParticipation(input, PARTICIPATION_READS);
  if (result.outcome === 'denied') return deny(result.reason, result.fields);
  const { side, meeting, subject, companyId, expertProfileId } = result;
  return { ok: true, side, meeting, subject, companyId, expertProfileId };
}
