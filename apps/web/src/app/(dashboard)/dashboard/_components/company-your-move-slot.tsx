import type { SessionUser } from '@/lib/auth/session';
import { loadClientYourMove } from '../_lib/load-client-your-move';
import { readYourMoveData } from '../_lib/read-your-move-data';
import { YourMove } from './your-move';

interface CompanyYourMoveSlotProps {
  readonly user: SessionUser;
  readonly companyId: string;
  readonly companyName: string;
}

/** The async SERVER slot for the company workspace's Your move rail. */
export async function CompanyYourMoveSlot({
  user,
  companyId,
  companyName,
}: Readonly<CompanyYourMoveSlotProps>): Promise<React.JSX.Element> {
  const data = await readYourMoveData(() => loadClientYourMove({ user, companyId, companyName }), {
    fallbackCards: [],
    logContext: { userId: user.id, companyId },
  });
  return <YourMove data={data} workspaceType="company" />;
}
