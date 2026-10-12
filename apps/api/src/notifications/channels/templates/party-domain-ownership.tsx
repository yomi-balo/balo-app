import { neutralPillStyle, PartyJoinEmail, successPillStyle } from './party-domain-join.js';

/**
 * Balo-staff domain changes (BAL-594). Both emails COMPOSE the `PartyJoinEmail` shell, so only
 * the copy differs. They go to the party's owners and admins and never name the staffer.
 */

/**
 * Where a party's domains are listed, per party type. A removal links the agency to the bare
 * settings page, since the Domains tab disappears once the last domain is gone.
 */
export function partyDomainsPath(partyType: unknown, event: 'added' | 'removed'): string {
  if (partyType !== 'agency') return '/settings/team';
  return event === 'removed' ? '/expert/settings' : '/expert/settings?tab=domains';
}

/**
 * The "domain added" body shared by the email and the in-app notice. A company's join setting
 * decides whether a matching signup actually joins, so its copy says so; an agency auto-joins.
 */
export function partyDomainAddedBody(
  partyType: unknown,
  partyName: string,
  domain: string
): string {
  const base = `We've added ${domain} to ${partyName}. New teammates with a ${domain} email can now join`;
  return partyType === 'agency' ? `${base}.` : `${base}, based on your join setting.`;
}

export interface PartyDomainOwnershipEmailProps {
  readonly firstName: string;
  readonly partyName: string;
  readonly domain: string;
  /** Absolute URL of the party's domains list. */
  readonly domainsUrl: string;
  readonly baseUrl: string;
  /** `'agency'` selects the agency copy; anything else is treated as a company. */
  readonly partyType?: unknown;
}

export function PartyDomainAddedEmail({
  firstName = 'there',
  partyName,
  domain,
  domainsUrl,
  baseUrl,
  partyType,
}: Readonly<PartyDomainOwnershipEmailProps>): ReturnType<typeof PartyJoinEmail> {
  return (
    <PartyJoinEmail
      firstName={firstName}
      previewText={`We've added ${domain} to ${partyName}`}
      pillLabel="Domain added"
      pillStyle={successPillStyle}
      heroHeading={`${domain} is now linked`}
      heroSubtext={`It's now one of ${partyName}'s domains.`}
      bodyText={partyDomainAddedBody(partyType, partyName, domain)}
      calloutHeading="Who this affects"
      calloutText="Only new signups. People who are already members keep their access exactly as it is."
      supportPrefix="Questions about your domains?"
      baseUrl={baseUrl}
      ctaLabel="View domains"
      ctaHref={domainsUrl}
    />
  );
}

export function PartyDomainRemovedEmail({
  firstName = 'there',
  partyName,
  domain,
  domainsUrl,
  baseUrl,
}: Readonly<PartyDomainOwnershipEmailProps>): ReturnType<typeof PartyJoinEmail> {
  return (
    <PartyJoinEmail
      firstName={firstName}
      previewText={`${domain} is no longer linked to ${partyName}`}
      pillLabel="Domain removed"
      pillStyle={neutralPillStyle}
      heroHeading={`${domain} is no longer linked`}
      heroSubtext={`It's no longer one of ${partyName}'s domains.`}
      bodyText={`${domain} is no longer linked to ${partyName}. New signups with a ${domain} email won't join ${partyName}.`}
      calloutHeading="Who this affects"
      calloutText="Only new signups. People who are already members keep their access exactly as it is."
      supportPrefix="Questions about your domains?"
      baseUrl={baseUrl}
      ctaLabel="View domains"
      ctaHref={domainsUrl}
    />
  );
}
