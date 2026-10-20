import type { SessionUser } from '@/lib/auth/session';
import { buildProjectTrack } from '../_lib/build-project-track';
import { loadClientYourMove } from '../_lib/load-client-your-move';
import { readYourMoveData } from '../_lib/read-your-move-data';
import { ProjectTrack } from './project-track';
import { YourMove } from './your-move';

interface CompanyYourMoveSlotProps {
  readonly user: SessionUser;
  readonly companyId: string;
  readonly companyName: string;
}

/**
 * The async SERVER slot for the company workspace's Your move rail and the project track below
 * it.
 */
export async function CompanyYourMoveSlot({
  user,
  companyId,
  companyName,
}: Readonly<CompanyYourMoveSlotProps>): Promise<React.JSX.Element> {
  const { rows, ...data } = await readYourMoveData(
    () => loadClientYourMove({ user, companyId, companyName }),
    {
      fallbackCards: [],
      logContext: { userId: user.id, companyId },
    }
  );
  const track = buildProjectTrack(rows, 'company');
  return (
    <>
      <YourMove data={data} workspaceType="company" />
      {track !== null && <ProjectTrack view={track} />}
    </>
  );
}
