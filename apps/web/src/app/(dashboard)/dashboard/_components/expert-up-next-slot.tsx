import { loadExpertUpNext } from '../_lib/load-up-next';
import { readUpNextData } from '../_lib/read-up-next-data';
import { resolveExpertUpNextSurface } from '../_lib/expert-up-next-surface';
import { UP_NEXT_COPY } from '../_lib/up-next-copy';
import { UpNextCard } from './up-next-card';
import { GhostConsultationsCard } from './ghost-consultations-card';
import type { ChecklistStatus } from '@/lib/actions/expert-checklist';
import type { UpNextFooterLink } from '../_lib/up-next-view-types';

interface ExpertUpNextSlotProps {
  readonly userId: string;
  readonly expertProfileId: string;
  readonly checklistStatus: Pick<ChecklistStatus, 'allComplete'> | null;
  readonly footerLinks: readonly UpNextFooterLink[];
}

/**
 * BAL-566 (R2) — the async SERVER slot for the EXPERT workspace's Up next card. Bookings always
 * win over the ghost card; the ghost shows only while setup is incomplete and nothing is booked.
 */
export async function ExpertUpNextSlot({
  userId,
  expertProfileId,
  checklistStatus,
  footerLinks,
}: Readonly<ExpertUpNextSlotProps>): Promise<React.JSX.Element> {
  // BAL-566 fix round 1 (F7) — `readUpNextData` is now overloaded on whether the loader can
  // return `null` (see its own docblock). `loadExpertUpNext` never does, so this call resolves to
  // `Promise<UpNextData>` and there is no null branch left to coalesce.
  const data = await readUpNextData(() => loadExpertUpNext({ expertProfileId }), {
    userId,
    expertProfileId,
    workspaceType: 'expert',
  });

  if (resolveExpertUpNextSurface(data, checklistStatus) === 'ghost') {
    return <GhostConsultationsCard />;
  }

  return (
    <UpNextCard
      data={data}
      workspaceType="expert"
      subtitle={UP_NEXT_COPY.expert.subtitle('')}
      footerLinks={footerLinks}
    />
  );
}
