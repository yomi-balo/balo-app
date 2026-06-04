import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { expertsRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { getCurrentUser } from '@/lib/auth/session';
import { getAvatarUrl } from '@/lib/storage/avatar-url';
import { mapProfileToView } from '@/lib/expert-profile/profile-view';
import { ExpertProfileClient } from './_components/expert-profile-client';

interface ExpertProfilePageProps {
  params: Promise<{ username: string }>;
}

export async function generateMetadata({ params }: ExpertProfilePageProps): Promise<Metadata> {
  const { username } = await params;
  const profile = await expertsRepository.findPublicProfileByUsername(username);

  if (!profile) {
    return { title: 'Expert Not Found — Balo' };
  }

  const name =
    [profile.user.firstName, profile.user.lastName].filter(Boolean).join(' ').trim() ||
    'Salesforce Expert';
  const firstName = profile.user.firstName?.trim() || 'This expert';

  return {
    title: `${name} — Balo Expert`,
    description: profile.headline ?? `${firstName} is a technology consultant on Balo.`,
    alternates: {
      canonical: `https://balo.expert/experts/${username}`,
    },
  };
}

export default async function ExpertProfilePage({
  params,
}: ExpertProfilePageProps): Promise<React.JSX.Element> {
  const { username } = await params;

  let profile: Awaited<ReturnType<typeof expertsRepository.findPublicProfileByUsername>>;
  try {
    profile = await expertsRepository.findPublicProfileByUsername(username);
  } catch (error) {
    log.error('Expert profile fetch failed', {
      username,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // let error.tsx render the boundary
  }

  if (!profile) {
    notFound();
  }

  const view = mapProfileToView(profile);
  const portraitUrl = getAvatarUrl(view.avatarKey, 'profile');
  const isLoggedIn = (await getCurrentUser()) !== null;

  return <ExpertProfileClient view={view} portraitUrl={portraitUrl} isLoggedIn={isLoggedIn} />;
}
