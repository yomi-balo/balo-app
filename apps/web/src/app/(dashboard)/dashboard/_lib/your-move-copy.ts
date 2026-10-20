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
export const YOUR_MOVE_CALENDAR_BODY = 'Clients can’t find you in search until it’s reconnected.';

export const YOUR_MOVE_ONGOING_ENGAGEMENT = 'Ongoing engagement';
