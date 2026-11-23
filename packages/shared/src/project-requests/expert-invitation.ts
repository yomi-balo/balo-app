/**
 * The expert's open-invitation rule: the one definition of when the Your move card asks an
 * expert to answer an invitation or a direct request.
 *
 * The projects-inbox row, the request page and the invitation reminder sequence all read THIS
 * rule, so a reminder stops exactly when the card would no longer show.
 *
 * The parameters are plain strings so this package stays free of `@balo/db`; callers pass the
 * statuses straight from their rows.
 */

/** The facts that decide whether a direct-request expert still owes the take-it-on-or-pass choice. */
export interface DirectRequestChoiceFacts {
  /** The viewer is the expert the direct request was sent to (`view.onDirectLeg`). */
  onDirectLeg: boolean;
  relationshipStatus: string;
  /** `request_expert_relationships.availability_shared_at` is set. */
  availabilityShared: boolean;
  /** The expert has written at least one live message in the request thread. */
  sentMessage: boolean;
}

/**
 * A directly requested expert is born at `eoi_submitted` with an automatic EOI, so they never
 * opted in. Until they share availability or write in the thread, their next step is to take it
 * on or pass.
 */
export function directExpertOwesChoice(facts: Readonly<DirectRequestChoiceFacts>): boolean {
  return (
    facts.onDirectLeg &&
    facts.relationshipStatus === 'eoi_submitted' &&
    !facts.availabilityShared &&
    !facts.sentMessage
  );
}

export type ExpertInvitationMove = 'invitation' | 'direct_request';

export interface ExpertInvitationFacts extends DirectRequestChoiceFacts {
  requestStatus: string;
}

/**
 * The Your move card the expert owes on an unanswered invitation, or null when none shows.
 * A closed, accepted or kickoff-approved request owes nothing on any relationship status.
 */
export function expertInvitationMove(
  facts: Readonly<ExpertInvitationFacts>
): ExpertInvitationMove | null {
  if (
    facts.requestStatus === 'closed' ||
    facts.requestStatus === 'accepted' ||
    facts.requestStatus === 'kickoff_approved'
  ) {
    return null;
  }
  if (facts.relationshipStatus === 'invited') return 'invitation';
  if (directExpertOwesChoice(facts)) return 'direct_request';
  return null;
}

/** The facts that decide whether an invited expert's reminder sequence is still waiting. */
export interface InvitationReminderFacts {
  requestStatus: string;
  relationshipStatus: string;
  /** The request was sent directly to this very expert. */
  onDirectLeg: boolean;
  availabilitySharedAt: Date | null;
  invitedAt: Date;
}

/**
 * The wait the invitation reminder sequence runs on, or null once the Your move card would no
 * longer show. The anchor is the invite instant. `sentMessage` is whether the expert has written
 * in the request thread. Both the sweep and the Lookup Follow-ups tab read this, so a reminder
 * stops exactly when the card does.
 */
export function invitationReminderWait(
  facts: Readonly<InvitationReminderFacts>,
  sentMessage: boolean
): { anchor: Date } | null {
  const move = expertInvitationMove({
    requestStatus: facts.requestStatus,
    relationshipStatus: facts.relationshipStatus,
    onDirectLeg: facts.onDirectLeg,
    availabilityShared: facts.availabilitySharedAt !== null,
    sentMessage,
  });
  return move === null ? null : { anchor: facts.invitedAt };
}
