import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth';
import { log } from '@/lib/logging';
import { userNotificationsRepository } from '@balo/db';

const uuidSchema = z.string().uuid();

export async function PATCH(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: 'Invalid notification ID' }, { status: 400 });
  }

  try {
    const notification = await userNotificationsRepository.markAsRead(id, user.id);

    if (!notification) {
      return NextResponse.json({ error: 'Notification not found' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      notification: { id: notification.id, readAt: notification.readAt },
    });
  } catch (error) {
    log.error('Failed to mark notification as read', {
      userId: user.id,
      notificationId: id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
