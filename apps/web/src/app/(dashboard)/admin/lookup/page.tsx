import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { loadLookup, type LookupPageDTO } from './_lib/load-lookup';
import { LookupShell } from './_components/lookup-shell';

/**
 * BAL-551 — Lookup: the platform-staff support entry point. One box that finds a user,
 * company, agency, expert profile, project request or credit session. Server Component:
 *  1. `getCurrentUser()` — null → `/login` (matching `admin/layout.tsx` / `admin/catalogue`,
 *     NOT `requireUser()`, which also throws on incomplete onboarding).
 *  2. non-staff → `notFound()` — repeated from `admin/layout.tsx` deliberately (defence in
 *     depth, D3; the `catalogue/page.tsx:11-14` precedent).
 *  3. `q` comes from the URL — a Promise in Next 16 (memory
 *     `reference_web_searchparams_promise_next16`).
 *  4. load through `loadLookup` inside a try/catch that `log.error`s (queryLength only — the
 *     query itself can be an email or a person's name) then re-throws to `admin/error.tsx`.
 *
 * READ-ONLY. Nothing here mutates — see `apps/web/src/invariants/admin-lookup-never-writes.test.ts`.
 */

export const metadata: Metadata = {
  title: 'Lookup — Balo',
  robots: { index: false, follow: false },
};

interface AdminLookupPageProps {
  searchParams: Promise<{ q?: string }>;
}

export default async function AdminLookupPage({
  searchParams,
}: Readonly<AdminLookupPageProps>): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    notFound();
  }

  const { q } = await searchParams;
  const query = typeof q === 'string' ? q : '';

  let dto: LookupPageDTO;
  try {
    dto = await loadLookup(user, query);
  } catch (error) {
    log.error('Admin lookup search failed', {
      userId: user.id,
      queryLength: query.length,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // let admin/error.tsx render the boundary
  }

  if (!dto.ok) {
    // The capability was re-checked inside loadLookup and failed there too — same boundary as
    // the page-level gate above. Reaching this is defence-in-depth, not a normal path.
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-1">
        {/* The shell's Breadcrumbs already renders THE ONE <h1> for this route (BAL-499 F5
            convention) — this in-page heading is demoted to <h2>. */}
        <h2 className="text-foreground text-2xl font-semibold">Lookup</h2>
        <p className="text-muted-foreground max-w-2xl text-sm">
          {/* pending-MJ */}
          Find a user, company, agency, expert, project request or credit session — the support
          entry point.
        </p>
      </div>
      <LookupShell
        query={query}
        results={dto.results}
        truncated={dto.truncated}
        tooShort={dto.tooShort}
      />
    </div>
  );
}
