'use client';

import type {
  PartyDomainWithCreator,
  PendingJoinRequestRow,
  ResolvedJoinRequestRow,
} from '@balo/db';
import { DomainsSection } from '@/components/balo/domain-join/domains-section';
import { PartyHeader } from './party-header';
import { JoinModeSection } from './join-mode-section';
import { JoinRequestsSection } from './join-requests-section';

export interface MembersAccessDto {
  companyId: string;
  companyName: string;
  domains: PartyDomainWithCreator[];
  mode: 'auto' | 'request' | 'off';
  lastChangedByName: string | null;
  lastChangedAt: Date | null;
  pending: PendingJoinRequestRow[];
  resolved: ResolvedJoinRequestRow[];
}

/**
 * The company "Members & access" shell (BAL-347): the THREE company sections —
 * Domains (shared) + Join mode + Join-request queue. Receives a plain, PII-free DTO
 * from the gated server page and wires the interactive sections. Company-only by
 * placement: the agency surface never imports this tree.
 */
export function MembersAccessClient({
  dto,
}: Readonly<{ dto: MembersAccessDto }>): React.JSX.Element {
  return (
    <div className="mx-auto max-w-3xl">
      <PartyHeader companyName={dto.companyName} />
      <div className="flex flex-col gap-4">
        <DomainsSection
          party="company"
          partyId={dto.companyId}
          partyName={dto.companyName}
          domains={dto.domains}
        />
        <JoinModeSection
          companyId={dto.companyId}
          initialMode={dto.mode}
          lastChangedByName={dto.lastChangedByName}
          lastChangedAt={dto.lastChangedAt}
        />
        <JoinRequestsSection mode={dto.mode} pending={dto.pending} resolved={dto.resolved} />
      </div>
    </div>
  );
}
