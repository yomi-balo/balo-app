import 'server-only';

import { getSession } from '@/lib/auth/session';
import { expertsRepository, usersRepository } from '@balo/db';
import { log } from '@/lib/logging';

export interface ChecklistStatus {
  items: {
    profile: boolean;
    rate: boolean;
    calendar: boolean;
    availability: boolean;
    payouts: boolean;
  };
  completedCount: number;
  allComplete: boolean;
}

/** Server-side function to compute checklist status. Called from server components. */
export async function getChecklistStatus(): Promise<ChecklistStatus> {
  const session = await getSession();
  if (!session?.user?.id) {
    throw new Error('Unauthorized');
  }

  if (session.user.activeMode !== 'expert') {
    throw new Error('Expert mode required');
  }

  const expertProfileId = session.user.expertProfileId;
  if (!expertProfileId) {
    throw new Error('Expert profile required');
  }

  const [profile, user] = await Promise.all([
    expertsRepository.findProfileById(expertProfileId),
    usersRepository.findById(session.user.id),
  ]);

  if (!profile || !user) {
    log.error('Profile or user not found in checklist', {
      expertProfileId,
      userId: session.user.id,
      profileFound: Boolean(profile),
      userFound: Boolean(user),
    });
    throw new Error('Profile or user not found');
  }

  const items = {
    profile: Boolean(
      profile.headline &&
      profile.bio &&
      user.avatarUrl &&
      profile.headline.trim().length > 0 &&
      profile.bio.trim().length > 0
    ),
    rate: Boolean(profile.hourlyRate && profile.hourlyRate > 0),
    calendar: Boolean(profile.cronofySyncStatus && profile.cronofySyncStatus !== 'not_connected'),
    availability: false, // TODO: BAL-195 — check availability_slots table
    payouts: Boolean(profile.stripeConnectId),
    // TODO: BAL-196 — check stripeChargesEnabled when column exists
  };

  const completedCount = Object.values(items).filter(Boolean).length;
  const allComplete = completedCount === 5;

  // When all 5 complete, set searchable = true (idempotent)
  if (allComplete && !profile.searchable) {
    await expertsRepository.updateProfile(expertProfileId, {
      searchable: true,
    });
    log.info('Expert became searchable', {
      expertProfileId,
      userId: session.user.id,
    });
  }

  return { items, completedCount, allComplete };
}
