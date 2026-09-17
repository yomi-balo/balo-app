import Link from 'next/link';
import { Suspense } from 'react';
import { Gift } from 'lucide-react';
import {
  getCurrentUser,
  getCompanyContext,
  requireUser,
  type SessionUser,
} from '@/lib/auth/session';
import { getChecklistStatus, type ChecklistStatus } from '@/lib/actions/expert-checklist';
import { buildNavContext, navWorkspaceTypeOf } from '@/lib/navigation/nav-context';
import { ExpertDashboard } from './_components/expert-dashboard';
import { WalletWidget } from '@/components/balo/credit/wallet-widget';
import { DashboardWalletSlot } from './_components/dashboard-wallet-slot';
import { CompanyUpNextSlot } from './_components/company-up-next-slot';
import { ExpertUpNextSlot } from './_components/expert-up-next-slot';
import { UpNextCardSkeleton } from './_components/up-next-card-skeleton';
import { resolveUpNextFooterLinks } from './_lib/up-next-footer-links';
import { log } from '@/lib/logging';
import type { UpNextFooterLink } from './_lib/up-next-view-types';

// Stable keys for the placeholder metric cards below (avoids array-index keys).
const METRIC_PLACEHOLDER_KEYS = ['activity', 'engagements', 'spend'];

/**
 * The expert-workspace branch. Unchanged checklist try/catch + `log.warn`; the new Up next slot
 * streams in beside the checklist/celebration card via `ExpertDashboard`'s `upNext` slot.
 */
async function renderExpertDashboard(
  user: SessionUser,
  expertProfileId: string,
  footerLinks: readonly UpNextFooterLink[]
): Promise<React.JSX.Element> {
  let checklistStatus: ChecklistStatus | null = null;
  try {
    checklistStatus = await getChecklistStatus();
  } catch (error) {
    log.warn('Failed to fetch checklist status for dashboard', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return (
    <ExpertDashboard
      checklistStatus={checklistStatus}
      userName={user.firstName ?? 'there'}
      upNext={
        <Suspense fallback={<UpNextCardSkeleton />}>
          <ExpertUpNextSlot
            userId={user.id}
            expertProfileId={expertProfileId}
            checklistStatus={checklistStatus}
            footerLinks={footerLinks}
          />
        </Suspense>
      }
    />
  );
}

/**
 * The company-workspace branch. Up next leads at 2fr, with the wallet and promo link beside it
 * at 1fr (D13); the metrics grid sits below, unchanged.
 */
async function renderCompanyDashboard(
  footerLinks: readonly UpNextFooterLink[]
): Promise<React.JSX.Element> {
  // Mirror the top-up page: the actor comes from requireUser() and companyId/companyName from
  // getCompanyContext().
  const actor = await requireUser();
  const { companyId, companyName } = await getCompanyContext();

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-foreground text-2xl font-semibold">Dashboard</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Welcome back. Here is an overview of your activity.
        </p>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Suspense fallback={<UpNextCardSkeleton />}>
          <CompanyUpNextSlot
            actorUserId={actor.id}
            companyId={companyId}
            companyName={companyName}
            footerLinks={footerLinks}
          />
        </Suspense>
        <div className="flex flex-col gap-4">
          {/* BAL-402: the company workspace's wallet card, streamed in after the rest of the page paints. */}
          <Suspense fallback={<WalletWidget state="loading" />}>
            <DashboardWalletSlot actor={actor} companyId={companyId} />
          </Suspense>
          {/* BAL-383: a lightweight entry point to the standalone /redeem surface. */}
          <Link
            href="/redeem"
            className="border-border bg-card hover:border-primary/40 focus-visible:ring-ring flex items-center gap-3 rounded-xl border p-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <span className="bg-primary/10 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
              <Gift className="text-primary h-4 w-4" aria-hidden="true" />
            </span>
            <span>
              <span className="text-foreground block text-sm font-medium">Have a promo code?</span>
              <span className="text-muted-foreground block text-xs">
                Redeem it to add credit — no card needed.
              </span>
            </span>
          </Link>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
        {METRIC_PLACEHOLDER_KEYS.map((slot) => (
          <div
            key={slot}
            className="border-border bg-card text-card-foreground rounded-xl border p-6"
          >
            <div className="space-y-3">
              <div className="bg-muted h-4 w-24 animate-pulse rounded" />
              <div className="bg-muted h-8 w-16 animate-pulse rounded" />
              <div className="bg-muted h-3 w-32 animate-pulse rounded" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default async function DashboardPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  const navContext = await buildNavContext(user);

  // F6 — footer links are resolved with the WORKSPACE THIS FUNCTION IS ABOUT TO RENDER, never
  // `navContext.workspaceType` blindly: an expert-mode session with no `expertProfileId` falls
  // through to the company branch below, and `navContext.workspaceType` still reads 'expert' in
  // that case (R1 / D11) — resolving footer links from it would hand the company card the
  // expert's "Open calendar" link instead of Cases/Projects.
  // ⚠ TRUTHINESS, not `!== undefined` — `requireExpert()` (`lib/auth/session.ts`) gates on
  // `!user.expertProfileId`, and `SessionUser` is a type assertion over cookie JSON with no
  // runtime validation, so an empty-string id is representable. Matching the house check keeps a
  // blank id on the company branch rather than rendering an expert dashboard that can only fail.
  if (user !== null && navWorkspaceTypeOf(user) === 'expert' && user.expertProfileId) {
    const footerLinks = resolveUpNextFooterLinks(navContext, 'expert');
    return renderExpertDashboard(user, user.expertProfileId, footerLinks);
  }
  const footerLinks = resolveUpNextFooterLinks(navContext, 'company');
  return renderCompanyDashboard(footerLinks);
}
