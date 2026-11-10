import { eq } from 'drizzle-orm';
import { db } from '../../client';
import { expertProfiles, users, type ExpertProfile } from '../../schema';
import { usersRepository } from '../../repositories/users';
import { searchExpertFactory } from '../factories/search-expert.factory';

/**
 * THE SHARED FIXTURE MATRIX FOR GATED PROFILE USERNAMES (`_shared/expert-profile-public.ts`).
 *
 * One way for `/experts/{username}` to resolve and every way for it not to. Each `apply` starts
 * from a visible profile (`searchExpertFactory` with a username, searchable) and breaks exactly
 * one input: the username itself, or one term of `expertProfileIsPublic`. Every read that
 * projects a gated username (`findDisplayProfileById`, `findPublicUsernamesByProfileIds`, the
 * cases index) runs this one matrix, so their fixtures cannot drift apart.
 */
export interface PublicProfileCase {
  readonly label: string;
  readonly isPublic: boolean;
  readonly apply: (profile: ExpertProfile) => Promise<void>;
}

async function setProfile(
  profile: ExpertProfile,
  values: Partial<Pick<ExpertProfile, 'username' | 'approvedAt' | 'searchable'>>
): Promise<void> {
  await db.update(expertProfiles).set(values).where(eq(expertProfiles.id, profile.id));
}

export const PUBLIC_PROFILE_MATRIX: readonly PublicProfileCase[] = [
  { label: 'visible', isPublic: true, apply: async () => undefined },
  { label: 'null username', isPublic: false, apply: (p) => setProfile(p, { username: null }) },
  { label: 'unapproved', isPublic: false, apply: (p) => setProfile(p, { approvedAt: null }) },
  { label: 'not searchable', isPublic: false, apply: (p) => setProfile(p, { searchable: false }) },
  {
    label: 'suspended owner',
    isPublic: false,
    apply: async (p) => {
      await db.update(users).set({ status: 'suspended' }).where(eq(users.id, p.userId));
    },
  },
  {
    label: 'soft-deleted owner',
    isPublic: false,
    apply: async (p) => {
      await usersRepository.softDelete(p.userId);
    },
  },
];

let seq = 0;

/** Seed a visible profile with a unique username, then break it the way `apply` says. */
export async function seedPublicProfileCase(
  apply: PublicProfileCase['apply']
): Promise<{ profile: ExpertProfile; username: string }> {
  seq++;
  const username = `public-matrix-${seq}-${Date.now()}`;
  const profile = await searchExpertFactory({ username, searchable: true });
  await apply(profile);
  return { profile, username };
}
