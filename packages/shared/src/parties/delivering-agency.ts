/**
 * delivering-agency — which agency an authorization, lens or notification path reads for a
 * subject, and where that agency comes from.
 *
 * An engagement records its delivering agency ONCE, at creation (`engagements.delivering_agency_id`).
 * Every path whose subject is an engagement reads that pin, so a later change to the expert
 * profile's agency link cannot move who holds rights over, sees, or is told about work already
 * delivered. Request-grain subjects (a discovery call, a request interaction, share-availability)
 * have no engagement row yet, so they read the expert profile's current agency.
 *
 * Pure: primitives only, no `@balo/db` import.
 */

export type DeliveringAgencySource =
  | {
      readonly from: 'engagement';
      /** `engagements.delivering_agency_id`. `null` ⇒ the profile had no agency link at creation. */
      readonly deliveringAgencyId: string | null;
    }
  | { readonly from: 'expert_profile' };

/**
 * The agency id the source names. A `null` engagement pin stays `null` even when the profile
 * has an agency now: the pin records "no agency" and must never fall back to the profile.
 */
export function deliveringAgencyIdFor(
  source: DeliveringAgencySource,
  profileAgencyId: string | null
): string | null {
  return source.from === 'engagement' ? source.deliveringAgencyId : profileAgencyId;
}
