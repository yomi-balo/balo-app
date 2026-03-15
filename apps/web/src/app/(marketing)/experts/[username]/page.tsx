import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { expertsRepository } from '@balo/db';

interface ExpertProfilePageProps {
  params: Promise<{ username: string }>;
}

export async function generateMetadata({ params }: ExpertProfilePageProps): Promise<Metadata> {
  const { username } = await params;
  const profile = await expertsRepository.findByUsername(username);

  if (!profile) {
    return { title: 'Expert Not Found — Balo' };
  }

  return {
    title: `${profile.user.firstName} ${profile.user.lastName} — Balo Expert`,
    description:
      profile.headline ?? `${profile.user.firstName} is a technology consultant on Balo.`,
    alternates: {
      canonical: `https://balo.expert/experts/${username}`,
    },
  };
}

export default async function ExpertProfilePage({
  params,
}: ExpertProfilePageProps): Promise<React.JSX.Element> {
  const { username } = await params;
  const profile = await expertsRepository.findByUsername(username);

  if (!profile) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-12">
      <h1 className="text-foreground text-2xl font-bold">
        {profile.user.firstName} {profile.user.lastName}
      </h1>
      {profile.headline && <p className="text-muted-foreground mt-2 text-lg">{profile.headline}</p>}
      {profile.bio && <p className="text-muted-foreground mt-4 leading-relaxed">{profile.bio}</p>}
    </div>
  );
}
