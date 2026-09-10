import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Zap, ArrowRight } from 'lucide-react';
import { adminAlertsRepository, adminSweepTicksRepository } from '@balo/db';
import { ADMIN_ALERT_PAGE_SIZE, type AdminAlertTileGroup } from '@balo/shared/admin-alerts';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import {
  buildAdminQueueView,
  parseAdminAlertGroupFilter,
  adminAlertKindsForGroupFilter,
  type AdminQueueView,
} from './_lib/admin-queue-view';
import { GroupTiles } from './_components/group-tiles';
import { AlertQueue } from './_components/alert-queue';
import { QueueEmpty, QueueFilteredEmpty } from './_components/queue-empty-states';
import { QueueErrorState } from './_components/queue-error-state';
import { AdminQueueAnalytics } from './_components/admin-queue-analytics';

/**
 * BAL-548 / ADR-1055 — Home: the pending-actions queue. REPLACES the BAL-534 redirect to
 * `/admin/catalogue` — `/admin` now has a home of its own. `admin/page.test.tsx`'s old suite
 * (which asserted the redirect) is replaced wholesale by this ticket's own suite, not deleted
 * silently.
 *
 * Server Component. Three reads inside one try/catch: `countOpenByKind()` (the exact
 * header/tile aggregate), `listOpenPage()` (the rows to render — filtered by the `?group=`
 * tile, when active), and `adminSweepTicksRepository.listTicks()` (the "swept Ns ago"
 * disclosure — a TABLE, not Redis; `apps/web` has no Redis client at all, R8).
 *
 * ⚠ WHEN A GROUP FILTER IS ACTIVE, A SECOND CHEAP READ (`listOpenPage({ limit: 1 })`,
 * unfiltered) FETCHES THE GLOBALLY-OLDEST OPEN ROW. The header line and the warm "Waiting…"
 * CTA both name the queue's oldest item REGARDLESS of the current filter (clicking the CTA
 * clears the filter — dropping `group` from its href IS "clear the filter"), so their source
 * cannot be the filtered `page.alerts[0]`. `countOpenByKind()` alone cannot answer this either
 * — it carries each kind's oldest TIMESTAMP but no `entityLabel` to build the CTA's short
 * name from. One extra `LIMIT 1` read over the keyset index is the cheapest way to keep that
 * property exact rather than approximate. When unfiltered, `page.alerts[0]` already IS that
 * row and the extra read is skipped.
 */
export const metadata: Metadata = {
  title: 'Home — Balo admin',
  robots: { index: false, follow: false },
};

/**
 * The three reads + the pure fold, isolated from the component so the component's own
 * cognitive complexity stays under the SonarCloud cap. Returns `null` on a read failure —
 * the caller logs and renders `<QueueErrorState/>`; this function never logs (it does not
 * know the acting user well enough to attribute the log line — see the caller).
 */
async function loadAdminQueueView(input: {
  readonly group: AdminAlertTileGroup | null;
  readonly kinds: readonly string[] | undefined;
  readonly canSeeFees: boolean;
}): Promise<AdminQueueView> {
  const [counts, page, ticks, oldestPage] = await Promise.all([
    adminAlertsRepository.countOpenByKind(),
    adminAlertsRepository.listOpenPage({ kinds: input.kinds, limit: ADMIN_ALERT_PAGE_SIZE }),
    adminSweepTicksRepository.listTicks(),
    input.group === null ? Promise.resolve(null) : adminAlertsRepository.listOpenPage({ limit: 1 }),
  ]);
  const [globalOldest] = oldestPage?.alerts ?? [];

  return buildAdminQueueView({
    counts,
    page,
    globalOldest: globalOldest ?? null,
    ticks,
    canSeeFees: input.canSeeFees,
    group: input.group,
    now: new Date(),
  });
}

/** The list region: the two empty states, or the queue itself. Extracted so the page's JSX
 *  carries no nested ternary (SonarCloud `sonarjs/no-nested-conditional`). */
function AdminQueueBody({
  view,
  kinds,
  canResolve,
  initialOpenId,
}: Readonly<{
  view: AdminQueueView;
  kinds: readonly string[] | undefined;
  canResolve: boolean;
  initialOpenId: string | null;
}>): React.JSX.Element {
  if (view.isEmpty) {
    return <QueueEmpty />;
  }
  if (view.isFilteredEmpty && view.groupLabel !== null && view.groupHint !== null) {
    return <QueueFilteredEmpty groupLabel={view.groupLabel} groupHint={view.groupHint} />;
  }
  return (
    <AlertQueue
      // BAL-548 fix round (B-F2): `AlertQueue` owns its row list in `useState(initialRows)`,
      // read only at mount. The group tiles and the warm CTA are both same-route-segment
      // `<Link>`s (`?group=` / `?open=`), so on that soft navigation `AlertQueue` sits at the
      // same position with the same element type and NO key — React preserves its instance,
      // and the row list silently keeps the pre-filter rows while everything around it
      // (tiles, header line, section label) updates from the fresh server render. Keying on
      // the filter + deep-link target forces a real remount whenever either changes, so the
      // list is always seeded from the current props.
      key={`${view.group ?? 'all'}:${initialOpenId ?? ''}`}
      initialRows={view.rows}
      initialHasMore={view.hasMore}
      initialCursor={view.nextCursor}
      kinds={kinds}
      canResolve={canResolve}
      initialOpenId={initialOpenId}
    />
  );
}

export default async function AdminHomePage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ group?: string; open?: string }>;
}>): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  // The third gate, repeated DELIBERATELY (D3) — same posture as `catalogue/page.tsx` and
  // `admin/layout.tsx`: a layout is not a hard auth boundary on its own.
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    notFound();
  }
  const canSeeFees = hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES);
  const canResolve = hasPlatformCapability(user, PLATFORM_CAPABILITIES.RESOLVE_ADMIN_ALERTS);

  const sp = await searchParams;
  const group = parseAdminAlertGroupFilter(sp.group);
  const kinds = group === null ? undefined : adminAlertKindsForGroupFilter(group);

  let view: AdminQueueView;
  try {
    view = await loadAdminQueueView({ group, kinds, canSeeFees });
  } catch (error) {
    log.error('Failed to load the admin pending-actions queue', {
      actorUserId: user.id,
      group,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return <QueueErrorState />;
  }

  return (
    <div className="flex flex-col gap-6">
      {/* BAL-548 analytics — `key` forces a fresh mount (and therefore a fresh once-per-mount
          fire) on a genuine filter change, rather than leaving it to the effect's own deps. */}
      <AdminQueueAnalytics
        key={group ?? 'all'}
        openCount={view.totalOpenCount}
        oldestAgeDays={view.oldestAgeDays}
        filter={group ?? 'all'}
      />
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-foreground text-2xl font-semibold">Home</h2>
          <p className="text-muted-foreground text-sm">{view.headerLine}</p>
        </div>
        {view.oldest !== null && (
          <Link
            href={`/admin?open=${view.oldest.id}`}
            className="from-warning to-destructive focus-visible:ring-ring inline-flex shrink-0 items-center gap-2 rounded-xl bg-gradient-to-r px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
          >
            <Zap className="size-4" aria-hidden="true" />
            Waiting {view.oldest.age} · {view.oldest.entityHead}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        )}
      </div>

      <GroupTiles tiles={view.tiles} />

      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-muted-foreground text-sm font-medium">
            {view.group === null ? 'Everything open' : view.groupLabel} · {view.rows.length}
          </p>
          {view.group === null ? (
            <span
              className={
                view.sweep.stale ? 'text-warning text-xs' : 'text-muted-foreground text-xs'
              }
              title={view.sweep.detail}
            >
              Oldest first · {view.sweep.staleLabel ?? view.sweep.summary}
            </span>
          ) : (
            <Link href="/admin" className="text-primary hover:text-primary/80 text-xs font-medium">
              Back to all
            </Link>
          )}
        </div>

        <AdminQueueBody
          view={view}
          kinds={kinds}
          canResolve={canResolve}
          initialOpenId={sp.open ?? null}
        />
      </div>
    </div>
  );
}
