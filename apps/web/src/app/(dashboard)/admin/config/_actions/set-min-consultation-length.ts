'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { platformConfigRepository } from '@balo/db';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { trackServerAndFlush, ADMIN_CONFIG_SERVER_EVENTS } from '@/lib/analytics/server';
import { log } from '@/lib/logging';
import {
  setMinConsultationSchema,
  MIN_LENGTH_ERROR,
  PERMISSION_DENIED,
  GENERIC_FAILURE,
} from './platform-config-schema';

/**
 * The set-minimum action's input. The form sends the whole-minute integer directly.
 */
export interface SetMinConsultationActionInput {
  minutes: number;
}

export type SetMinConsultationResult =
  | { success: true; minutes: number }
  | { success: false; error: string };

/**
 * Admin platform-config mutation (BAL-398). Authorization is the platform-capability axis
 * (`MANAGE_PLATFORM_CONFIG`), resolved at the call site — NOT `platformRole ===`. Auth gates
 * run BEFORE the input is parsed; an unauthenticated / uncapable caller gets a generic
 * permission error (no existence leak). Uses `getCurrentUser()` (the promo-codes precedent),
 * not `requireUser()`: a platform capability implies an onboarded admin, and the BAL-365
 * onboarding-mutation-gate invariant flags only bare `requireUser(`.
 *
 * The repo upserts the singleton row; the DB CHECK is the structural money-floor backstop
 * (the Zod refine is the friendly pre-check). One server analytics event + a `log.info` fire
 * on success only.
 */
export async function setMinConsultationLength(
  input: SetMinConsultationActionInput
): Promise<SetMinConsultationResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { success: false, error: PERMISSION_DENIED };
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_CONFIG)) {
    return { success: false, error: PERMISSION_DENIED };
  }

  const parsed = setMinConsultationSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: MIN_LENGTH_ERROR };
  }

  try {
    const row = await platformConfigRepository.setMinConsultationMinutes(
      parsed.data.minutes,
      user.id
    );

    log.info('Admin set min consultation length', {
      minutes: row.minConsultationMinutes,
      actorUserId: user.id,
    });
    trackServerAndFlush(ADMIN_CONFIG_SERVER_EVENTS.MIN_CONSULTATION_LENGTH_SET, {
      minutes: row.minConsultationMinutes,
      distinct_id: user.id,
    });

    revalidatePath('/admin/config');

    return { success: true, minutes: row.minConsultationMinutes };
  } catch (error) {
    log.error('Failed to set min consultation length', {
      actorUserId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
