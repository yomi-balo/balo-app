import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { log } from '@/lib/logging';
import { userNotificationsRepository, usersRepository } from '@balo/db';

// Read items shown after the unread ones in the panel.
const PANEL_READ_LIMIT = 5;

const querySchema = z.object({
  unread: z.enum(['true']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
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

  const { unread, limit } = parsed.data;

  try {
    const lastSeenAt = await usersRepository.findNotificationsLastSeenAt(user.id);
    // A null cursor means "never initialised": nothing is unseen until the client seeds it.
    const [rawNotifications, { unread: unreadCount, unseen: unseenCount }] = await Promise.all([
      unread === 'true'
        ? userNotificationsRepository.findUnreadByUserId(user.id, limit)
        : userNotificationsRepository.findPanelByUserId(user.id, {
            unreadLimit: limit,
            readLimit: PANEL_READ_LIMIT,
          }),
      userNotificationsRepository.countUnreadAndUnseenByUserId(user.id, lastSeenAt),
    ]);

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
      impersonating: isImpersonatedSession(user),
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
