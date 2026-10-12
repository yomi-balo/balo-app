import type { PartyDomainForSettings } from '@balo/db';
import { DomainsSection } from '@/components/balo/domain-join/domains-section';

interface AgencyDomainsTabProps {
  partyName: string;
  /** `null` signals a load error for this tab (the page logged + degraded gracefully). */
  domains: PartyDomainForSettings[] | null;
}

/**
 * The agency Domains tab (BAL-347) — a read-only view of the agency's domains. Balo staff
 * manage them (BAL-594). Structural party-type guarantee: this tree imports ONLY
 * `DomainsSection` — it has NO import path to the company-only join-mode / join-request
 * components, so they cannot render for an agency.
 */
export function AgencyDomainsTab({
  partyName,
  domains,
}: Readonly<AgencyDomainsTabProps>): React.JSX.Element {
  return <DomainsSection party="agency" partyName={partyName} domains={domains} />;
}
