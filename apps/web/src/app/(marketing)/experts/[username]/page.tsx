import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { expertsRepository } from '@balo/db';
import { extractEmailDomain } from '@balo/shared/domains';
import { log } from '@/lib/logging';
import { getCurrentUser } from '@/lib/auth/session';
import { getAvatarUrl } from '@/lib/storage/avatar-url';
import { mapProfileToView } from '@/lib/expert-profile/profile-view';
import { loadProjectRequestTaxonomies } from '@/lib/project-request/load-project-taxonomy';
import { loadSearchTaxonomy } from '@/lib/search/load-taxonomy';
import { loadBookingContext } from '@/lib/booking/load-booking-context';
import { serializeBookingContext } from '@/lib/booking/serialize-booking-context';
import type { BookingContext } from '@/components/booking';
import type { BookingSource } from '@/lib/analytics';
import { ExpertProfileClient } from './_components/expert-profile-client';

interface ExpertProfilePageProps {
  params: Promise<{ username: string }>;
  searchParams: Promise<{ book?: string; src?: string }>;
}

/** `?src=` → `BookingSource` (D4a entry points 2 and 4, which deep-link here). Default `'profile'`. */
function resolveBookingSource(src: string | undefined): BookingSource {
  if (src === 'search' || src === 'book_again' || src === 'home_spotlight') return src;
  return 'profile';
}

/**
 * Request-scoped memo so `generateMetadata` and the page component share a
 * single DB query per render (React `cache()` dedupes within one server
 * request). Without this the gated profile read runs twice on every page load.
 */
const loadPublicProfile = cache((username: string) =>
  expertsRepository.findPublicProfileByUsername(username)
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ username: string }>;
}): Promise<Metadata> {
  const { username } = await params;
  const profile = await loadPublicProfile(username);

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
  searchParams,
}: Readonly<ExpertProfilePageProps>): Promise<React.JSX.Element> {
  const { username } = await params;
  // ⚠ Next 16: `searchParams` is a Promise — must be awaited (memory
  // `reference_web_searchparams_promise_next16`).
  const { book, src } = await searchParams;
  const autoOpenBooking = book === '1';
  const autoOpenBookingSource = resolveBookingSource(src);

  let profile: Awaited<ReturnType<typeof loadPublicProfile>>;
  try {
    profile = await loadPublicProfile(username);
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
  const bookingAvatarUrl = getAvatarUrl(view.avatarKey, 'thumbnail');

  // Independent reads — run in parallel. `loadProjectRequestTaxonomies` / `loadSearchTaxonomy`
  // never throw (degrade to EMPTY), so a picker shows its error state with Retry rather than
  // the page failing.
  const [user, projectTaxonomies, productsTaxonomy] = await Promise.all([
    getCurrentUser(),
    loadProjectRequestTaxonomies(),
    loadSearchTaxonomy(),
  ]);
  const isLoggedIn = user !== null;

  // BAL-400 (D1a) — the booking Step 0 read. Only resolved when signed in (`loadBookingContext`
  // needs a `userId`); a signed-out visitor sees the auth modal first (client-side), and the
  // wrapper's own reset effect re-derives this once `router.refresh()` lands a signed-in user.
  const bookingContext: BookingContext | null = isLoggedIn
    ? serializeBookingContext(await loadBookingContext(view.expertId, user.id))
    : null;
  const viewerEmailDomain = isLoggedIn ? extractEmailDomain(user.email) : null;

  return (
    <ExpertProfileClient
      view={view}
      portraitUrl={portraitUrl}
      bookingAvatarUrl={bookingAvatarUrl}
      isLoggedIn={isLoggedIn}
      projectTaxonomies={projectTaxonomies}
      productsTaxonomy={productsTaxonomy}
      bookingContext={bookingContext}
      viewerEmailDomain={viewerEmailDomain}
      autoOpenBooking={autoOpenBooking}
      autoOpenBookingSource={autoOpenBookingSource}
    />
  );
}
