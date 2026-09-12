import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { joinNameParts } from '@balo/shared/parties';
import {
  parseCaptureHealthWindow,
  parseCaptureHealthCategory,
  parseCaptureHealthPinnedRow,
} from './_lib/window';
import { loadCaptureHealth, type CaptureHealthPageDTO } from './_lib/load-capture-health';
import { HealthTiles } from './_components/health-tiles';
import { HealthWindowControl } from './_components/health-window-control';
import { HealthList } from './_components/health-list';
import { PinnedHealthRow } from './_components/pinned-health-row';
import { CaptureHealthEmpty, CaptureHealthFilteredEmpty } from './_components/health-empty-states';
import { HealthErrorState } from './_components/health-error-state';
import { CaptureHealthAnalytics } from './_components/capture-health-analytics';

/**
 * BAL-550 — `/admin/health/capture`: every recorded consultation with its three pipelines
 * (recording, transcription, recap), and the two re-drives that keep them moving.
 *
 * 1. `getCurrentUser()` → `redirect('/login')` when null — matching `admin/layout.tsx` /
 *    `catalogue/page.tsx` / `lookup/page.tsx`, NOT `requireUser()`.
 * 2. `!hasPlatformCapability(VIEW_PLATFORM_ADMIN)` → `notFound()` — repeated DELIBERATELY
 *    (defence in depth; the layout already gates the whole `/admin/*` subtree).
 * 3. `canRedrive = hasPlatformCapability(REDRIVE_JOB)` — threaded down to disable the button
 *    and swap its copy; the api re-checks it against the live row (the real gate).
 * 4. `searchParams` is a Promise in Next 16.
 * 5. `loadCaptureHealth` inside try/catch → `log.error` (no query text — the params are an
 *    enum, two dates and a uuid) → the caught `HealthErrorState`, never a re-throw (the
 *    `admin/error.tsx` boundary stays for a genuinely unexpected throw).
 * 6. THE ONE `<h1>` is the shell's Breadcrumbs (BAL-499 F5); this page's heading is `<h2>`.
 */

export const metadata: Metadata = {
  title: 'Capture health — Balo admin',
  robots: { index: false, follow: false },
};

interface CaptureHealthPageProps {
  searchParams: Promise<{ category?: string; row?: string; from?: string; to?: string }>;
}

export default async function CaptureHealthPage({
  searchParams,
}: Readonly<CaptureHealthPageProps>): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    notFound();
  }
  const canRedrive = hasPlatformCapability(user, PLATFORM_CAPABILITIES.REDRIVE_JOB);

  const { category: rawCategory, row: rawRow, from, to } = await searchParams;
  const window = parseCaptureHealthWindow({ from, to });
  const category = parseCaptureHealthCategory(rawCategory);
  // ⚠ A NON-UUID `?row=` IS "not found", NEVER A THROW — see `parseCaptureHealthPinnedRow`.
  // It still gets the "not on this page" note: a link that named SOMETHING and resolved to
  // nothing reads identically to a link naming a meeting outside the window.
  const pinnedMeetingId = parseCaptureHealthPinnedRow(rawRow);
  const pinnedUnresolvable =
    typeof rawRow === 'string' && rawRow.length > 0 && pinnedMeetingId === null;

  let dto: CaptureHealthPageDTO;
  try {
    dto = await loadCaptureHealth({ window, category, pinnedMeetingId });
  } catch (error) {
    log.error('Failed to load capture health', {
      actorUserId: user.id,
      category,
      windowDays: window.days,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return (
      <div className="flex flex-col gap-6">
        <Heading />
        <HealthErrorState />
      </div>
    );
  }

  const actorLabel = joinNameParts(user.firstName, user.lastName) ?? user.email;
  const isFilteredEmpty = dto.rows.length === 0 && dto.pinned === null && !dto.isTrueZero;

  /**
   * ⚠⚠ EVERY CLIENT COMPONENT BELOW SEEDS `useState` FROM SERVER PROPS, WHICH REACT KEEPS ACROSS
   * A RE-RENDER OF THE SAME ELEMENT POSITION. Both the tiles (`<Link>`) and the window control
   * (`router.push`) navigate WITHIN this route, so the server re-renders with new props while
   * React reuses the same instances and their state. Unkeyed, `HealthList` would show the
   * previous filter's rows under the new active tile — and worse, "Load more" would send the
   * PREVIOUS filter's cursor with the NEW category, paging one filter's rows into another.
   *
   * The key is the exact input set of the server read (`listPage`'s category + window), so the
   * components remount precisely when that read changes and never on an unrelated re-render.
   * ⚠ NOT `window.days`: two DIFFERENT windows of equal length share a `days`, which would
   * suppress the second view event and keep the stale list.
   */
  const viewKey = `${category ?? 'all'}:${window.fromIso}:${window.toIso}`;

  return (
    <div className="flex flex-col gap-6">
      <Heading />
      <CaptureHealthAnalytics
        key={viewKey}
        windowDays={window.days}
        filter={category ?? 'all'}
        issueCount={dto.issueCount}
      />

      <HealthTiles counts={dto.tiles} active={category} windowParams={{ from, to }} />

      <div className="flex items-center justify-between gap-3">
        <HealthWindowControl
          key={viewKey}
          fromIso={window.fromIso}
          toIso={window.toIso}
          days={window.days}
          fellBack={window.fellBack}
        />
        <span className="text-muted-foreground text-xs">Issues first</span>
      </div>

      {(dto.pinnedMissing || pinnedUnresolvable) && (
        <p className="text-muted-foreground text-[12.5px]">
          That consultation is no longer on this page.
        </p>
      )}

      {dto.pinned !== null && (
        <PinnedHealthRow row={dto.pinned} canRedrive={canRedrive} actorLabel={actorLabel} />
      )}

      {dto.isTrueZero && dto.pinned === null && <CaptureHealthEmpty />}
      {isFilteredEmpty && <CaptureHealthFilteredEmpty hasCategoryFilter={category !== null} />}
      {!dto.isTrueZero && !isFilteredEmpty && (
        <HealthList
          key={viewKey}
          initialRows={dto.rows}
          initialHasMore={dto.hasMore}
          initialCursor={dto.nextCursor}
          fromIso={dto.window.fromIso}
          toIso={dto.window.toIso}
          category={category}
          withheldBeforeIso={dto.withheldBeforeIso}
          canRedrive={canRedrive}
          actorLabel={actorLabel}
        />
      )}
    </div>
  );
}

function Heading(): React.JSX.Element {
  return (
    <div className="space-y-1">
      {/* The shell's Breadcrumbs already renders THE ONE <h1> for this route (BAL-499 F5
          convention) — this in-page heading is demoted to <h2>. */}
      <h2 className="text-foreground text-2xl font-semibold">Capture health</h2>
      <p className="text-muted-foreground max-w-2xl text-sm">
        Every recorded consultation with its three pipelines — recording, transcription, recap.
        Re-drive lives here.
      </p>
    </div>
  );
}
