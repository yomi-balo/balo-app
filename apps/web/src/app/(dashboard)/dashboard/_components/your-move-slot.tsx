import { buildCalendarCards } from '../_lib/build-your-move-cards';
import { loadExpertYourMove } from '../_lib/load-your-move';
import { readYourMoveData } from '../_lib/read-your-move-data';
import { YourMove } from './your-move';
import type { SessionUser } from '@/lib/auth/session';

interface YourMoveSlotProps {
  readonly user: SessionUser;
  readonly expertProfileId: string;
  readonly calendarNeedsReconnect: boolean;
}

/** The async SERVER slot for the expert workspace's Your move rail. */
export async function YourMoveSlot({
  user,
  expertProfileId,
  calendarNeedsReconnect,
}: Readonly<YourMoveSlotProps>): Promise<React.JSX.Element> {
  const data = await readYourMoveData(
    () => loadExpertYourMove({ user: { ...user, expertProfileId }, calendarNeedsReconnect }),
    {
      fallbackCards: buildCalendarCards({ calendarNeedsReconnect, now: new Date() }),
      logContext: { userId: user.id, expertProfileId },
    }
  );
  return <YourMove data={data} workspaceType="expert" />;
}
