import type { ProposalChangeSection } from '@balo/db';

export const YOUR_MOVE_TITLE = 'Your move';
export const YOUR_MOVE_EMPTY = 'Nothing’s waiting on you';
export const YOUR_MOVE_ERROR = 'We couldn’t load what’s waiting on you.';
export const YOUR_MOVE_RETRY = 'Try again';
export const YOUR_MOVE_RETRYING = 'Trying again…';

export const yourMoveCountSentence = (n: number): string =>
  n === 1 ? '1 thing is waiting on you' : `${n} things are waiting on you`;

export const yourMoveInvitedFact = (rel: string): string => `Invited ${rel}`;
export const yourMoveInterestFact = (rel: string): string => `Interest sent ${rel}`;
export const yourMoveRequestedFact = (rel: string): string => `Requested ${rel}`;
export const yourMoveAcceptedFact = (rel: string): string => `Accepted ${rel}`;
export const yourMoveAskedFact = (rel: string): string => `Asked ${rel}`;
export const yourMoveOverdueFact = (n: number): string => `${n} overdue`;

export const yourMoveEoiSentence = (company: string): string =>
  `Share your availability so ${company} can book an intro call.`;

export const yourMoveDraftSaved = (rel: string): string => `Draft saved ${rel}`;
export const YOUR_MOVE_DRAFT_NOT_STARTED = 'Not started yet';

export const YOUR_MOVE_ACTION_REPLY = 'Reply';
export const YOUR_MOVE_ACTION_FINISH_PROPOSAL = 'Finish proposal';

export const YOUR_MOVE_GATE_LABELS: Record<'billing' | 'terms' | 'approval', string> = {
  billing: 'Client billing',
  terms: 'Your terms',
  approval: 'Balo approval',
};

/** `general` has no label: the card shows the note with no section chip. */
export const YOUR_MOVE_SECTION_LABELS: Record<ProposalChangeSection, string | null> = {
  general: null,
  milestones: 'Milestones / deliverables',
  pricing: 'Pricing',
  payment_terms: 'Payment terms',
  timeline: 'Timeline',
};

export const yourMoveUnreadTitle = (unread: number, conversations: number): string =>
  `${unread} unread in ${conversations} ${conversations === 1 ? 'conversation' : 'conversations'}`;

/** `A` / `A and B` / `A, B and {k} more`. */
export function yourMoveCompaniesSentence(names: readonly string[]): string {
  const [first, second, ...rest] = names;
  if (first === undefined) return '';
  if (second === undefined) return first;
  if (rest.length === 0) return `${first} and ${second}`;
  return `${first}, ${second} and ${rest.length} more`;
}

export const YOUR_MOVE_CALENDAR_TITLE = 'Reconnect your calendar';
export const YOUR_MOVE_CALENDAR_COUNTERPARTY = 'Out of search';
export const YOUR_MOVE_CALENDAR_BODY =
  'While it’s disconnected, you won’t appear in expert search.';

export const YOUR_MOVE_ONGOING_ENGAGEMENT = 'Ongoing engagement';

export const YOUR_MOVE_BALO = 'Balo';
export const YOUR_MOVE_EXPLORATORY_BODY =
  'Book a short call with Balo so we can find the right experts for this brief.';

export const YOUR_MOVE_BILLING_TITLE = 'Outstanding balance';
export const YOUR_MOVE_BILLING_COUNTERPARTY = 'New bookings are on hold';
export const YOUR_MOVE_BILLING_BODY = 'Settling it lifts the hold on new bookings.';

export const YOUR_MOVE_CLIENT_GATE_LABELS: Record<'billing' | 'terms' | 'approval', string> = {
  billing: 'Your billing',
  terms: 'Expert terms',
  approval: 'Balo approval',
};

/** The billing gate's label for a member who cannot confirm billing: it is not theirs to do. */
export const YOUR_MOVE_KICKOFF_MEMBER_BILLING_LABEL = 'Company billing';

/** Mirrors the kickoff board's member notice; a client module, so it is pinned by a test, not imported. */
export const YOUR_MOVE_KICKOFF_MEMBER_NOTE =
  'A company owner or admin needs to add these billing details before kickoff.';
export const YOUR_MOVE_ACTION_VIEW_KICKOFF = 'View kickoff';

export const yourMoveReviewProposalsAction = (n: number): string => `Review ${n} proposals`;

export const yourMoveSentFact = (rel: string): string => `Sent ${rel}`;
export const yourMoveSinceFact = (rel: string): string => `Since ${rel}`;
export const yourMoveRelFact = (rel: string): string =>
  `${rel.charAt(0).toUpperCase()}${rel.slice(1)}`;

export const yourMoveJoinTitle = (n: number): string =>
  n === 1 ? '1 person asked to join' : `${n} people asked to join`;
export const yourMoveAboutWeeks = (n: number): string => `About ${n} ${n === 1 ? 'week' : 'weeks'}`;

export const YOUR_MOVE_STAT_LABELS: Record<'version' | 'timeframe' | 'milestones', string> = {
  version: 'Version',
  timeframe: 'Timeframe',
  milestones: 'Milestones',
};

export const yourMoveMilestonesComplete = (done: number, total: number): string =>
  `${done} of ${total} milestones complete`;
export const yourMoveAutoAccepts = (day: string): string => `Accepted automatically on ${day}`;
export const yourMoveWas = (dateTime: string): string => `Was ${dateTime}`;

export const YOUR_MOVE_DATED_FACT: Record<
  'reply_by' | 'since' | 'marked_complete',
  (day: string) => string
> = {
  reply_by: (day) => `Reply by ${day}`,
  since: (day) => `Since ${day}`,
  marked_complete: (day) => `Marked complete ${day}`,
};

/** "Person, Agency", or "Person" for an independent expert. */
export function yourMoveExpertCounterparty(input: {
  readonly personName: string;
  readonly agencyLabel: string | null;
}): string {
  return input.agencyLabel === null || input.agencyLabel === ''
    ? input.personName
    : `${input.personName}, ${input.agencyLabel}`;
}
