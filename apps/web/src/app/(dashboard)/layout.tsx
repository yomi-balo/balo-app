import { Suspense } from 'react';
import { getCurrentUser } from '@/lib/auth/session';
import { checkSessionDrift } from '@/lib/auth/session-sync';
import { getChecklistStatus } from '@/lib/actions/expert-checklist';
import { buildNavContext } from '@/lib/navigation/nav-context';
import { getWorkspacesForCurrentUser } from '@/lib/workspaces/get-workspaces';
import { activeWorkspaceKeyOf } from '@/lib/workspaces/session-workspace';
import { SidebarProvider } from '@/components/layout/sidebar-context';
import { BreadcrumbProvider } from '@/components/layout/breadcrumb-context';
import { SessionSyncRedirect } from '@/components/layout/session-sync-redirect';
import { TopNav } from '@/components/layout/top-nav';
import { Sidebar } from '@/components/layout/sidebar';
import { MobileTabBar } from '@/components/layout/mobile-tab-bar';
import { CreditsChipSlot } from '@/components/layout/credits-chip-slot';
import { CreditsChipSkeleton } from '@/components/layout/credits-chip';
import { creditsChipIsInScope } from '@/components/layout/credits-chip-scope';
import { buildLiveStatusView, type LiveStatusView } from '@/lib/expert/live-status-view';
import { log } from '@/lib/logging';
import { getAvatarUrl } from '@/lib/storage/avatar-url';
import { analyticsIdentifyPropsFor } from '@/lib/auth/impersonation';
import { AnalyticsIdentify } from '@/components/providers/analytics-identify';
import { ViewerTimezoneProvider } from '@/components/balo/date/viewer-timezone-context';
import { LiveJoinRegistryProvider } from '@/components/balo/meetings/live-join-registry';
import { TimezoneMismatchGate } from '@/components/balo/timezone-mismatch/timezone-mismatch-gate';
import { loadViewerTimezoneContext } from '@/lib/timezone/load-viewer-timezone-context';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  // Read-only drift check — if sync needed, hard-navigate to the route handler, which can safely
  // mutate cookies. A client component does the navigation: an RSC `redirect()` thrown from this
  // cached layout segment is re-thrown on every client navigation and loops.
  const checkResult = await checkSessionDrift();

  if (checkResult.action === 'sync-needed') {
    return <SessionSyncRedirect />;
  }

  // After sync, session is guaranteed fresh — read user normally
  const user = await getCurrentUser();

  // Independent of the checklist read below and of `activeMode`: the saved zone is read for every
  // signed-in user, and the mismatch prompt is decided by the expert profile's own data. Started
  // here so it runs alongside the nav and checklist reads.
  const timezoneContextPromise = user ? loadViewerTimezoneContext(user) : null;

  // Fetch checklist status only for expert mode users with a profile
  let checklistCompletedCount = 0;
  let checklistAllComplete = false;
  let liveStatus: LiveStatusView | null = null;
  if (user?.activeMode === 'expert' && user.expertProfileId) {
    try {
      const status = await getChecklistStatus();
      checklistCompletedCount = status.completedCount;
      checklistAllComplete = status.allComplete;
      liveStatus = buildLiveStatusView(status);
    } catch (error) {
      log.warn('Failed to fetch checklist status for layout', {
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const [navContext, timezoneContext] = await Promise.all([
    buildNavContext(user),
    timezoneContextPromise,
  ]);

  // BAL-496 (D13) — the switcher's list. Mirrors the `navContext` precedent BAL-495 added one
  // commit ago: this layout is an async Server Component and the SOLE renderer of
  // `SidebarProvider`. Costs no extra reads — `checkSessionDrift()` above already ran
  // `deriveWorkspacesForUser` and it is React-`cache()`d per request, so this replays a memo.
  // Returns `[]` (never throws) when there is no session user or nothing is derivable.
  const workspaces = await getWorkspacesForCurrentUser();

  // ⚠ THE ACTIVE-KEY SOURCE. `activeWorkspaceKeyOf` is the SINGLE reader of the session's
  // active-workspace shape — nothing here hand-destructures `user.activeWorkspace`, and nothing
  // recomputes the key from `activeMode`/`companyId`, which would fork the resolution rule.
  const activeWorkspaceKey = user === null ? null : (activeWorkspaceKeyOf(user) ?? null);

  const userName = user
    ? [user.firstName, user.lastName].filter(Boolean).join(' ') ||
      user.email.split('@')[0] ||
      'User'
    : 'User';
  const userInitials = user
    ? [user.firstName?.[0], user.lastName?.[0]].filter(Boolean).join('').toUpperCase() || 'U'
    : 'U';

  // BAL-499 (D2/D8) — THE GATE, resolved server-side and OUTSIDE the `<Suspense>` boundary: in
  // an expert workspace this ternary yields `null`, so neither the chip nor its skeleton is ever
  // constructed and the RSC payload carries no chip node to hydrate. Never gated client-side
  // from `useSidebar()` / `navContext` — that would re-introduce exactly the hydration flash
  // the AC prohibits.
  const creditsChip =
    user !== null && creditsChipIsInScope(navContext) ? (
      <Suspense fallback={<CreditsChipSkeleton />}>
        <CreditsChipSlot actorId={user.id} companyId={user.companyId} />
      </Suspense>
    ) : null;

  return (
    <SidebarProvider
      activeMode={user?.activeMode ?? 'client'}
      userName={userName}
      userInitials={userInitials}
      userAvatarUrl={getAvatarUrl(user?.avatarUrl ?? null, 'thumbnail')}
      checklistCompletedCount={checklistCompletedCount}
      checklistAllComplete={checklistAllComplete}
      navContext={navContext}
      workspaces={workspaces}
      activeWorkspaceKey={activeWorkspaceKey}
      liveStatus={liveStatus}
    >
      <AnalyticsIdentify {...analyticsIdentifyPropsFor(user)} />
      <ViewerTimezoneProvider savedTimezone={timezoneContext?.savedTimezone ?? null}>
        {timezoneContext?.mismatchPrompt ? (
          <TimezoneMismatchGate mismatchPrompt={timezoneContext.mismatchPrompt} />
        ) : null}
        <BreadcrumbProvider>
          <LiveJoinRegistryProvider>
            {/* §2.3 — `min-h-dvh`, NEVER `min-h-screen`: mobile browser chrome makes `100vh` taller
              than the visible viewport, which would leave phantom scroll under the sticky tab
              bar. `100dvh === 100vh` on desktop, so this is inert there. */}
            <div className="bg-background min-h-dvh">
              <div className="flex">
                <Sidebar />
                {/* `min-w-0` lets the column shrink below its content's min-content width, so a
                  horizontal rail (dashboard Your move) scrolls inside itself instead of widening
                  the page past the viewport. */}
                <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
                  <TopNav creditsChip={creditsChip} />
                  <main className="flex-1 p-6 lg:p-8">
                    <div className="mx-auto max-w-7xl">{children}</div>
                  </main>
                  {/* `sticky bottom-0` IN FLOW (never `fixed`) — §2.3's ruling. `<main>` needs no
                    extra bottom padding and `AppFooter` (rendered by the root layout, outside
                    this tree) needs no changes. */}
                  <MobileTabBar />
                </div>
              </div>
            </div>
          </LiveJoinRegistryProvider>
        </BreadcrumbProvider>
      </ViewerTimezoneProvider>
    </SidebarProvider>
  );
}
