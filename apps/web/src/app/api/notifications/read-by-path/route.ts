import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getCurrentUser } from '@/lib/auth';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { log } from '@/lib/logging';
import { userNotificationsRepository } from '@balo/db';
import { rejectNonJsonContentType } from '../require-json-content-type';

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

// Rooted path with no query, fragment or control characters.
const bodySchema = z.object({
  path: z
    .string()
    .max(500)
    .regex(/^\/[^?#]*$/)
    .refine((value) => !hasControlCharacter(value)),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Impersonated sessions write nothing: reading as the user must not consume their unread state.
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
    const readIds = await userNotificationsRepository.markReadByActionPath(
      user.id,
      parsed.data.path
    );
    return NextResponse.json({ readIds });
  } catch (error) {
    log.error('Failed to mark notifications read by path', {
      userId: user.id,
      path: parsed.data.path,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
