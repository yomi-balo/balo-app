import 'server-only';

import { cache } from 'react';
import { usersRepository } from '@balo/db';
import { log, errorMessage } from '@/lib/logging';
import type { SessionUser } from '@/lib/auth/session';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { mostCommonWeeklyRange, type WeeklyRange } from './common-weekly-range';

export interface MismatchPrompt {
  expertProfileId: string;
  scheduleTimezone: string;
  commonRange: WeeklyRange | null;
}

export interface ViewerTimezoneContext {
  /** `users.timezone`, or `null` when none is saved. */
  savedTimezone: string | null;
  /** Present only for an approved, unpaused expert with weekly hours to re-read. */
  mismatchPrompt: MismatchPrompt | null;
}

const EMPTY_CONTEXT: ViewerTimezoneContext = { savedTimezone: null, mismatchPrompt: null };

async function load(
  userId: string,
  expertProfileId: string | undefined
): Promise<ViewerTimezoneContext> {
  try {
    const context = await usersRepository.findTimezoneContext(userId, expertProfileId);
    if (!context) return EMPTY_CONTEXT;

    const { savedTimezone, expert } = context;
    if (!expert?.approved || !expert.availableForWork || expert.rules.length === 0) {
      return { savedTimezone, mismatchPrompt: null };
    }

    return {
      savedTimezone,
      mismatchPrompt: {
        expertProfileId: expert.expertProfileId,
        scheduleTimezone: expert.timezone,
        commonRange: mostCommonWeeklyRange(expert.rules),
      },
    };
  } catch (error) {
    log.warn('Failed to load viewer timezone context', { userId, error: errorMessage(error) });
    return EMPTY_CONTEXT;
  }
}

/** Memoised on the two ids, which are primitives, so repeat calls in a request share one read. */
const loadCached = cache(load);

/**
 * The saved timezone for every signed-in user, plus whether an expert should be asked about a
 * device-zone change. Eligibility comes from the expert profile's own data and never from the
 * active view, so the prompt can appear in either workspace. An impersonated session never gets
 * the prompt: the device zone belongs to the admin, not the expert.
 */
export async function loadViewerTimezoneContext(
  user: Pick<SessionUser, 'id' | 'expertProfileId'> & Parameters<typeof isImpersonatedSession>[0]
): Promise<ViewerTimezoneContext> {
  const context = await loadCached(user.id, user.expertProfileId);
  if (isImpersonatedSession(user)) return { ...context, mismatchPrompt: null };
  return context;
}
