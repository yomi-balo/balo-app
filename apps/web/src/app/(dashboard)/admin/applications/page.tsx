import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { loadApplications, type ApplicationsPageDTO } from './_lib/load-applications';
import { resolveApplicationFilter, toApplicationListRowView } from './_lib/application-list-view';
import { ApplicationsAnalytics } from './_components/applications-analytics';
import { ApplicationList } from './_components/application-list';

/**
 * BAL-549 — Applications: the expert-application review queue. Server Component:
 *  1. `getCurrentUser()` — null → `/login` (matching `admin/layout.tsx` / `admin/catalogue`,
 *     NOT `requireUser()`, which also throws on incomplete onboarding).
 *  2. non-staff → `notFound()` — repeated from `admin/layout.tsx` deliberately (defence in
 *     depth, D3; the `catalogue/page.tsx` / `lookup/page.tsx` precedent).
 *  3. `filter` comes from the URL — a Promise in Next 16 (memory
 *     `reference_web_searchparams_promise_next16`). Narrowed through
 *     `resolveApplicationFilter` (a fixed-tuple `find`, never a bare index or regex).
 *  4. load through `loadApplications` inside a try/catch that `log.error`s (never the query
 *     itself — there is none here, just `filter`) then re-throws to `error.tsx`.
 */

export const metadata: Metadata = {
  title: 'Applications — Balo',
  robots: { index: false, follow: false },
};

interface AdminApplicationsPageProps {
  searchParams: Promise<{ filter?: string }>;
}

export default async function AdminApplicationsPage({
  searchParams,
}: Readonly<AdminApplicationsPageProps>): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    notFound();
  }

  const { filter: rawFilter } = await searchParams;
  const filter = resolveApplicationFilter(rawFilter);

  let dto: ApplicationsPageDTO;
  try {
    dto = await loadApplications(user, filter);
  } catch (error) {
    log.error('Admin applications list failed', {
      userId: user.id,
      filter,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // let error.tsx render the boundary
  }

  if (!dto.ok) {
    // The capability was re-checked inside loadApplications and failed there too — same
    // boundary as the page-level gate above. Reaching this is defence-in-depth, not a normal
    // path.
    notFound();
  }

  const now = new Date();
  const rows = dto.rows.map((row) => toApplicationListRowView(row, filter, now));
  const oldestDays = filter === 'pending' ? (rows[0]?.daysWaiting ?? 0) : 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-1">
        {/* The shell's Breadcrumbs already renders THE ONE <h1> for this route (BAL-499 F5
            convention) — this in-page heading is demoted to <h2>. */}
        <h2 className="text-foreground text-2xl font-semibold">Applications</h2>
        <p className="text-muted-foreground max-w-2xl text-sm">
          {/* pending-MJ */}
          Review expert applications — approve, or decline with a reason and a Balo-only note.
        </p>
      </div>
      <ApplicationsAnalytics
        key={filter}
        pendingCount={dto.counts.pending}
        oldestDays={oldestDays}
      />
      <ApplicationList filter={filter} rows={rows} counts={dto.counts} truncated={dto.truncated} />
    </div>
  );
}
