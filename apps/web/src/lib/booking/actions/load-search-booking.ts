'use server';
import 'server-only';

import { z } from 'zod';
import { expertsRepository } from '@balo/db';
import { extractEmailDomain } from '@balo/shared/domains';
import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { getAvatarUrl } from '@/lib/storage/avatar-url';
import { mapProfileToView } from '@/lib/expert-profile/profile-view';
import { buildBookingFlowExpert } from '../booking-flow-expert';
import { loadBookingContext } from '../load-booking-context';
import { serializeBookingContext } from '../serialize-booking-context';
import type { LoadSearchBookingInput, LoadSearchBookingResult } from './load-search-booking-types';

/**
 * Everything the booking wrapper needs to open in place on the expert search grid: the same
 * public-profile read and Step 0 `loadBookingContext` the profile page resolves server-side for
 * `?book=1`, fetched on the "Book a call" click instead of on a page load.
 *
 * A read, not a mutation: like the profile page it needs a signed-in user, not an onboarded one
 * (`loadBookingContext`'s `onboarding_required` arm is how the wrapper routes the rest).
 */
const inputSchema = z.object({ username: z.string().min(1).max(100) }).strict();

export async function loadSearchBookingAction(
  rawInput: LoadSearchBookingInput
): Promise<LoadSearchBookingResult> {
  const user = await getCurrentUser();
  if (user === null) return { ok: false, reason: 'signed_out' };

  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    log.warn('Search booking load rejected — invalid input', { userId: user.id });
    return { ok: false, reason: 'unavailable' };
  }
  const { username } = parsed.data;

  let profile: Awaited<ReturnType<typeof expertsRepository.findPublicProfileByUsername>>;
  try {
    profile = await expertsRepository.findPublicProfileByUsername(username);
  } catch (error) {
    log.error('Search booking profile fetch failed', {
      username,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, reason: 'unavailable' };
  }
  if (!profile) return { ok: false, reason: 'unavailable' };

  const view = mapProfileToView(profile);
  // A paused expert takes no new bookings; their profile shows the alternatives.
  if (!view.availableForWork) return { ok: false, reason: 'unavailable' };

  const context = serializeBookingContext(await loadBookingContext(view.expertId, user.id));
  return {
    ok: true,
    expert: buildBookingFlowExpert(view, getAvatarUrl(view.avatarKey, 'thumbnail')),
    context,
    viewerEmailDomain: extractEmailDomain(user.email),
  };
}
