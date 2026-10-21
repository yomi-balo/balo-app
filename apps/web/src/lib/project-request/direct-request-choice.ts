/**
 * The take-it-on-or-pass choice on a DIRECT request (BAL-604).
 *
 * A directly requested expert is born at `eoi_submitted` with an automatic EOI, so they never
 * opted in. Until they act on the request — share availability ("Propose times") or write in
 * the thread — their next step is to take it on or pass, not the generic "propose times" one.
 * The request-page nudge and the projects-inbox row both read THIS predicate; once it turns
 * false, the normal `eoi_submitted` nudges apply.
 */
export interface DirectRequestChoiceFacts {
  /** The viewer is the expert the direct request was sent to (`view.onDirectLeg`). */
  onDirectLeg: boolean;
  relationshipStatus: string;
  /** `request_expert_relationships.availability_shared_at` is set. */
  availabilityShared: boolean;
  /** The expert has written at least one live message in the request thread. */
  sentMessage: boolean;
}

export function directExpertOwesChoice(facts: Readonly<DirectRequestChoiceFacts>): boolean {
  return (
    facts.onDirectLeg &&
    facts.relationshipStatus === 'eoi_submitted' &&
    !facts.availabilityShared &&
    !facts.sentMessage
  );
}

/** The inbox / Your move label for the choice. */
export const DIRECT_CHOICE_LABEL = 'Take it on, or pass?'; // pending-MJ

/** The request-page nudge headline for the choice — names the client party. */
export function directChoiceHeadline(companyName: string): string {
  return `${companyName} asked for you directly. Take it on, or pass?`; // pending-MJ
}
