import { loadCompanyUpNext } from '../_lib/load-up-next';
import { readUpNextData } from '../_lib/read-up-next-data';
import { UP_NEXT_COPY } from '../_lib/up-next-copy';
import { UpNextCard } from './up-next-card';
import type { UpNextFooterLink } from '../_lib/up-next-view-types';

interface CompanyUpNextSlotProps {
  readonly actorUserId: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly footerLinks: readonly UpNextFooterLink[];
}

/**
 * BAL-566 — the async SERVER slot for the COMPANY workspace's Up next card. Mirrors
 * `DashboardWalletSlot`'s shape: the catch boundary lives one level down
 * (`readUpNextData`), so this component stays a thin composition.
 */
export async function CompanyUpNextSlot({
  actorUserId,
  companyId,
  companyName,
  footerLinks,
}: Readonly<CompanyUpNextSlotProps>): Promise<React.JSX.Element | null> {
  const data = await readUpNextData(() => loadCompanyUpNext({ actorUserId, companyId }), {
    userId: actorUserId,
    companyId,
    workspaceType: 'company',
  });
  if (data === null) {
    // R1 — the viewer does not participate in the workspace company. Omit the card entirely.
    return null;
  }
  return (
    <UpNextCard
      data={data}
      workspaceType="company"
      subtitle={UP_NEXT_COPY.company.subtitle(companyName)}
      footerLinks={footerLinks}
    />
  );
}
