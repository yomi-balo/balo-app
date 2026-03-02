'use server';

import 'server-only';

import { getSession } from '@/lib/auth/session';
import { usersRepository } from '@balo/db';
import { type AuthResult } from '@/lib/auth/errors';
import { z } from 'zod';

const VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

const timezoneSchema = z
  .string()
  .min(1, 'Timezone is required')
  .refine((tz) => VALID_TIMEZONES.has(tz), 'Invalid timezone');

export async function updateTimezoneAction(timezone: string): Promise<AuthResult> {
  const parsed = timezoneSchema.safeParse(timezone);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid timezone' };
  }

  const session = await getSession();
  if (!session?.user?.id) {
    return { success: false, error: 'Unauthorized' };
  }

  try {
    await usersRepository.update(session.user.id, { timezone: parsed.data });
    return { success: true };
  } catch {
    return { success: false, error: 'Failed to save timezone. Please try again.' };
  }
}
