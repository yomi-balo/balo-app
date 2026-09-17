import { personDisplayName } from '@balo/shared/parties';

/** The three name columns the client-side expert-counterparty rule needs. */
export interface ExpertCounterpartyNameFields {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly agencyName: string | null;
}

/**
 * BAL-566 (D7) — THE CLIENT SIDE'S NAME FOR THE DELIVERING EXPERT, extracted so
 * `meetings/[meetingId]/_lib/resolve-counterparty.ts`, `cases/[engagementId]/_lib/load-case.ts`
 * and the dashboard Up next card share one rule.
 *
 * The PERSON ("An expert" fallback when unnamed) is the name; the agency is the org line — `null`
 * for an independent expert. Emails are never an input and never an output.
 */
export function expertCounterpartyLabels(fields: ExpertCounterpartyNameFields): {
  readonly personName: string;
  readonly agencyLabel: string | null;
} {
  return {
    personName: personDisplayName(fields.firstName, fields.lastName, 'An expert'),
    agencyLabel: fields.agencyName,
  };
}
