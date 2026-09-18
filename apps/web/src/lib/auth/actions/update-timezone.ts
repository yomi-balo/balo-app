'use server';

import 'server-only';

import { getSession } from '@/lib/auth/session';
import { accountRefusalFor } from '@/lib/auth/account-liveness';
import { usersRepository } from '@balo/db';
import { type AuthResult } from '@/lib/auth/errors';
import { deriveCountryFromTimezone } from '@balo/shared/timezone';
import { log } from '@/lib/logging';
import { z } from 'zod';

const VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

const timezoneSchema = z
  .string()
  .min(1, 'Timezone is required')
  .refine((tz) => VALID_TIMEZONES.has(tz), 'Invalid timezone');

export async function updateTimezoneAction(timezone: string): Promise<AuthResult> {
  // BAL-568 — ACCOUNT LIVENESS against the LIVE row, ABOVE THE PARSE (R9; fix round 1, F4). One of
  // the bounded `getSession()`-only set — see `complete-onboarding.ts` for the full reasoning,
  // including why this is `accountRefusalFor` rather than `assertAccountLive`.
  const session = await getSession();
  if (!session?.user?.id) {
    return { success: false, error: 'Unauthorized' };
  }
  if ((await accountRefusalFor(session.user.id, { path: 'action', emit: true })) !== null) {
    return { success: false, error: 'Unauthorized' };
  }

  const parsed = timezoneSchema.safeParse(timezone);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid timezone' };
  }

  try {
    const countryData = deriveCountryFromTimezone(parsed.data);
    await usersRepository.update(session.user.id, {
      timezone: parsed.data,
      ...(countryData && { country: countryData.country, countryCode: countryData.countryCode }),
    });
    return { success: true };
  } catch (error) {
    log.error('Failed to save timezone', {
      userId: session.user.id,
      timezone: parsed.data,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Failed to save timezone. Please try again.' };
  }
}
