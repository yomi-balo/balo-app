import { PartyJoinEmail } from './party-domain-join.js';
import { shared } from './shared.js';

/**
 * Balo-staff domain changes (BAL-594). Both emails COMPOSE the `PartyJoinEmail` shell, so only
 * the copy differs. They go to the party's owners and admins and never name the staffer.
 */

const successPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(5, 150, 105, 0.18)',
  border: '1px solid rgba(5, 150, 105, 0.35)',
  color: '#A7F3D0',
};

const neutralPillStyle = {
  ...shared.statusPillBase,
  background: 'rgba(124, 58, 237, 0.18)',
  border: '1px solid rgba(124, 58, 237, 0.35)',
  color: '#DDD6FE',
};

/**
 * Where a party's domains are listed, per party type. A removal links the agency to the bare
 * settings page, since the Domains tab disappears once the last domain is gone.
 */
export function partyDomainsPath(partyType: unknown, event: 'added' | 'removed'): string {
  if (partyType !== 'agency') return '/settings/team';
  return event === 'removed' ? '/expert/settings' : '/expert/settings?tab=domains';
}

export interface PartyDomainOwnershipEmailProps {
  readonly firstName: string;
  readonly partyName: string;
  readonly domain: string;
  /** Absolute URL of the party's domains list. */
  readonly domainsUrl: string;
  readonly baseUrl: string;
}

export function PartyDomainAddedEmail({
  firstName = 'there',
  partyName,
  domain,
  domainsUrl,
  baseUrl,
}: Readonly<PartyDomainOwnershipEmailProps>): ReturnType<typeof PartyJoinEmail> {
  return (
    <PartyJoinEmail
      firstName={firstName}
      previewText={`We've added ${domain} to ${partyName}`}
      pillLabel="Domain added"
      pillStyle={successPillStyle}
      heroHeading={`${domain} is now linked`}
      heroSubtext={`It's now one of ${partyName}'s domains.`}
      bodyText={`We've added ${domain} to ${partyName}. New teammates with a ${domain} email can now join.`}
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
