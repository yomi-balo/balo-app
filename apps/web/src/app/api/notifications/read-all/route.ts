import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { log } from '@/lib/logging';
import { userNotificationsRepository } from '@balo/db';

export async function POST(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const count = await userNotificationsRepository.markAllAsRead(user.id);
    return NextResponse.json({ success: true, count });
  } catch (error) {
    log.error('Failed to mark all notifications as read', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
