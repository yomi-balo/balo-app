import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth';
import { log } from '@/lib/logging';
import { userNotificationsRepository, usersRepository } from '@balo/db';

const querySchema = z.object({
  unread: z.enum(['true']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const params = Object.fromEntries(request.nextUrl.searchParams);
  const parsed = querySchema.safeParse(params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid query parameters', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { unread, limit, offset } = parsed.data;

  try {
    const [rawNotifications, unreadCount, lastSeenAt] = await Promise.all([
      unread === 'true'
        ? userNotificationsRepository.findUnreadByUserId(user.id, limit)
        : userNotificationsRepository.findByUserId(user.id, limit, offset),
      userNotificationsRepository.countUnreadByUserId(user.id),
      usersRepository.findNotificationsLastSeenAt(user.id),
    ]);

    // A null cursor means "never initialised": nothing is unseen until the client seeds it.
    const unseenCount = lastSeenAt
      ? await userNotificationsRepository.countUnseenByUserId(user.id, lastSeenAt)
      : 0;

    // Project only client-needed fields (omit metadata, userId, updatedAt, deletedAt)
    const notifications = rawNotifications.map(
      ({ id, event, title, body, actionUrl, readAt, createdAt }) => ({
        id,
        event,
        title,
        body,
        actionUrl,
        readAt,
        createdAt,
      })
    );

    return NextResponse.json({
      notifications,
      unreadCount,
      lastSeenAt: lastSeenAt?.toISOString() ?? null,
      unseenCount,
    });
  } catch (error) {
    log.error('Failed to fetch notifications', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
