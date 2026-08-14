import type { MeetingViewerRole } from '@balo/shared/meetings';
import type { WaitingAbsentParty, WaitingSubject } from './waiting-copy';

/**
 * BAL-435 (ruling R10) — TURN THE MEMBER-JOIN ENVELOPE INTO THE WAITING STAGE'S SUBJECT.
 *
 * ⚠⚠ ONE PURE FUNCTION, SO THE "WHO IS MISSING" DECISION IS TESTABLE WITHOUT A DAILY MOCK, A
 * ROUTER OR A RENDER. It is the whole of ruling R10's client half:
 *
 *   viewerRole 'client'  ⇒  the EXPERT is the absent party
 *   viewerRole 'expert'  ⇒  the CLIENT is the absent party
 *   anything missing     ⇒  `null`, and the stage renders party-neutral copy
 *
 * ⚠ `viewerRole` IS THE SERVER'S VERDICT (`authorizeMeetingParticipation`'s resolved side), NOT A
 * LENS AND NOT `activeMode`. It is a fact about the room — which side of the meeting the actor
 * was authorized onto — and that is precisely why the waiting stage may branch on it while
 * nothing else on this surface may branch on anything view-shaped (ADR-1029).
 *
 * ⚠ ALL THREE PIECES OR NONE. A subject with a real name and a placeholder time is how
 * `"the scheduled time"` shipped as a literal; this function returns `null` rather than assemble
 * a half-true one.
 */

/**
 * ⚠ A LOOKUP, NOT A TERNARY CHAIN. Two arms today, and "the other side" is a fact worth stating
 * once rather than inverting at each call site (SonarCloud also flags nested ternaries).
 */
const ABSENT_PARTY_BY_VIEWER: Record<MeetingViewerRole, WaitingAbsentParty> = {
  client: 'expert',
  expert: 'client',
};

export interface WaitingSubjectInput {
  readonly viewerRole: MeetingViewerRole | null;
  readonly counterpartyFirstName: string | null;
  /** Already formatted in the VIEWER's timezone — see `format-scheduled-start.ts`. */
  readonly scheduledStartLabel: string | null;
}

export function resolveWaitingSubject(input: WaitingSubjectInput): WaitingSubject | null {
  const { viewerRole, counterpartyFirstName, scheduledStartLabel } = input;
  if (viewerRole === null || counterpartyFirstName === null || scheduledStartLabel === null) {
    return null;
  }
  return {
    absentParty: ABSENT_PARTY_BY_VIEWER[viewerRole],
    counterpartyFirstName,
    scheduledStartLabel,
  };
}
