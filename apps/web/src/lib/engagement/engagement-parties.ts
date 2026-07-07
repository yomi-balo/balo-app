import type { EngagementWithMilestones } from '@balo/db';
import type { EngagementLens } from './resolve-engagement-lens';

/**
 * Party / person copy engine for the delivery workspace (BAL-329 conventions,
 * binding). PURE; `@balo/db` is imported TYPE-ONLY (erased at build — never pulls
 * the postgres client into a bundle). Consumed by the server-side view mapper
 * (`engagement-view.ts`) — components never call this directly, they read the
 * derived strings off `EngagementWorkspaceView`.
 *
 * Two binding rules:
 *  - gender-neutral ALWAYS (names only, never pronouns / gendered nouns);
 *  - PROSPECTIVE copy names the PARTY (the client company, or the agency when the
 *    expert is agency-based); RETROSPECTIVE copy names the PERSON, "@ company /
 *    agency" on first mention.
 */
export interface EngagementParties {
  /** The expert delivers under an agency (`expertProfile.agency !== null`). */
  isAgencyExpert: boolean;
  /** Retrospective full person name, e.g. `Priya Sharma`. */
  expertPerson: string;
  /** First-name person label, e.g. `Priya` (message CTA / short retrospective). */
  expertPersonShort: string;
  /** Prospective party: agency name when agency, else the person. */
  expertParty: string;
  /** Short prospective party label (agency name when agency, else first name). */
  expertPartyShort: string;
  /** The expert's specialty headline (independent header suffix) — may be null. */
  expertHeadline: string | null;
  /** Retrospective first-mention: `Priya @ CloudPeak Consulting` (agency) | `Priya`. */
  expertRetroFirstMention: string;
  /** The client company display name, e.g. `Northwind Industrial`. */
  clientCompanyName: string;
}

/** Gender-neutral join of the name parts; empty → the supplied fallback. */
function joinName(firstName: string | null, lastName: string | null, fallback: string): string {
  const parts = [firstName, lastName].filter(
    (part): part is string => part !== null && part.trim() !== ''
  );
  return parts.length > 0 ? parts.join(' ') : fallback;
}

/**
 * Derive every party / person string for an engagement from the hydrated read
 * model. `isAgencyExpert = expertProfile.agency !== null`; the person always comes
 * from `expertProfile.user` (gender-neutral full + first name).
 */
export function deriveEngagementParties(e: EngagementWithMilestones): EngagementParties {
  const { user, agency, headline } = e.expertProfile;
  const isAgencyExpert = agency !== null;

  const expertPerson = joinName(user.firstName, user.lastName, 'the expert');
  const expertPersonShort =
    user.firstName !== null && user.firstName.trim() !== '' ? user.firstName : expertPerson;

  const expertParty = isAgencyExpert ? agency.name : expertPerson;
  const expertPartyShort = isAgencyExpert ? agency.name : expertPersonShort;
  const expertRetroFirstMention = isAgencyExpert
    ? `${expertPersonShort} @ ${agency.name}`
    : expertPersonShort;

  return {
    isAgencyExpert,
    expertPerson,
    expertPersonShort,
    expertParty,
    expertPartyShort,
    expertHeadline: headline,
    expertRetroFirstMention,
    clientCompanyName: e.company.name,
  };
}

/**
 * Retrospective client-person attribution, first mention, e.g.
 * `Dana @ Northwind Industrial`. Uses the FIRST name (matching the BAL-329
 * attribution examples and the expert's `Priya @ CloudPeak` first-mention form),
 * falling back to the last name. When the person is missing (null / unnamed) the
 * party alone is used (`Northwind Industrial`) so attribution never renders a
 * dangling `@`.
 */
export function personAtCompany(
  person: { firstName: string | null; lastName: string | null } | null,
  companyName: string
): string {
  if (person === null) return companyName;
  const name = (person.firstName ?? '').trim() || (person.lastName ?? '').trim();
  return name === '' ? companyName : `${name} @ ${companyName}`;
}

/**
 * The per-lens header sub-line under the engagement title.
 *  - client   → prospective "Delivered by …" naming the expert PARTY (+ person &
 *               headline in the parenthetical / suffix);
 *  - expert   → "For {clientCompanyName}";
 *  - admin    → "{clientCompanyName} ↔ {expertParty} ({expertPerson})" (agency) |
 *               "{clientCompanyName} ↔ {expertPerson}" (independent).
 */
export function engagementHeaderLine(lens: EngagementLens, p: EngagementParties): string {
  if (lens === 'expert') {
    return `For ${p.clientCompanyName}`;
  }
  if (lens === 'admin') {
    return p.isAgencyExpert
      ? `${p.clientCompanyName} ↔ ${p.expertParty} (${p.expertPerson})`
      : `${p.clientCompanyName} ↔ ${p.expertPerson}`;
  }
  // client lens — prospective, party-named.
  if (p.isAgencyExpert) {
    return p.expertHeadline !== null && p.expertHeadline.trim() !== ''
      ? `Delivered by ${p.expertParty} (${p.expertPerson}, ${p.expertHeadline})`
      : `Delivered by ${p.expertParty} (${p.expertPerson})`;
  }
  return p.expertHeadline !== null && p.expertHeadline.trim() !== ''
    ? `Delivered by ${p.expertPerson} — ${p.expertHeadline}`
    : `Delivered by ${p.expertPerson}`;
}
