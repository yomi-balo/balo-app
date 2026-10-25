import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { log } from '@/lib/logging';
import { usersRepository } from '@balo/db';
import { rejectNonJsonContentType } from '../require-json-content-type';

const bodySchema = z.object({ through: z.iso.datetime() });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Impersonated sessions write nothing: the cursor belongs to the real user.
  if (isImpersonatedSession(user)) {
    return NextResponse.json({ skipped: true });
  }

  const unsupported = rejectNonJsonContentType(request);
  if (unsupported) {
    return unsupported;
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    const lastSeenAt = await usersRepository.advanceNotificationsSeenThrough(
      user.id,
      new Date(parsed.data.through)
    );
    return NextResponse.json({ lastSeenAt: lastSeenAt?.toISOString() ?? null });
  } catch (error) {
    log.error('Failed to advance notifications seen cursor', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
