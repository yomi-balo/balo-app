/**
 * parties — the PURE, transport-agnostic counterpart display-name helper
 * (BAL-329 / BAL-336). NO `db` import, NO I/O: it takes PRIMITIVE fields (an
 * expert party `type` plus the agency/person names) so BOTH the server-side A7
 * inbox loader (D6) AND D1's client-side workspace components can import it via
 * the `@balo/shared/parties` subpath without dragging the postgres driver into
 * any client bundle — the same isolation rationale as `@balo/shared/domains`.
 */

/** The expert party kind — mirrors `expertTypeEnum` without importing `@balo/db`. */
export type ExpertPartyType = 'freelancer' | 'agency';

/** The primitive fields the display-name convention needs (never a full DB row). */
export interface ExpertPartyNameInput {
  type: ExpertPartyType;
  agencyName: string | null;
  firstName: string | null;
  lastName: string | null;
}

/**
 * Party-vs-person convention (BAL-329): an agency shows its agency name; a
 * freelancer — or an agency whose name is blank — shows the person's name.
 * Falls back to a neutral "An expert" when no name resolves. Shared by D6 (inbox)
 * and D1 (workspace). Do NOT reuse submit-eoi.ts's person-only helper.
 */
export function expertPartyDisplayName(party: ExpertPartyNameInput): string {
  if (party.type === 'agency') {
    const agency = party.agencyName?.trim();
    if (agency) return agency;
  }
  const full = [party.firstName, party.lastName]
    .filter((part): part is string => part !== null && part.trim().length > 0)
    .join(' ')
    .trim();
  return full.length > 0 ? full : 'An expert';
}
