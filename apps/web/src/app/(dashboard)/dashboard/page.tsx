import { Suspense } from 'react';
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
import { DashboardRefreshOnFocus } from './_components/dashboard-refresh-on-focus';
import { CompanyYourMoveSlot } from './_components/company-your-move-slot';
import { YourMoveSlot } from './_components/your-move-slot';
import { YourMoveSkeleton } from './_components/your-move-skeleton';
import { ApplicationReviewBannerSlot } from './_components/application-review-banner-slot';
import { resolveUpNextFooterLinks } from './_lib/up-next-footer-links';
import { log } from '@/lib/logging';
import { DASHBOARD_WALLET_SLOT_CLASS } from '@/lib/credit/display-constants';
import type { UpNextFooterLink } from './_lib/up-next-view-types';

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
      yourMove={
        <Suspense fallback={<YourMoveSkeleton />}>
          <YourMoveSlot
            user={user}
            expertProfileId={expertProfileId}
            calendarNeedsReconnect={checklistStatus?.calendarNeedsReconnect === true}
          />
        </Suspense>
      }
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
 * The company-workspace branch: header, then Up next at 2fr beside the wallet (promo entry inside
 * the card) at 1fr, stretched to one height, then Your move.
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
      <DashboardRefreshOnFocus />
      <div className="mb-8">
        <h1 className="text-foreground text-2xl font-semibold">
          Welcome back, {actor.firstName ?? 'there'}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Here’s what’s happening across {companyName}.
        </p>
      </div>

      {/* An expert applicant awaiting a decision lands here (no expert workspace until approved).
          Streams in on its own; a failed read renders nothing rather than blocking the page. */}
      <Suspense fallback={null}>
        <ApplicationReviewBannerSlot userId={actor.id} email={actor.email} />
      </Suspense>

      <div className="mb-4 grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Suspense fallback={<UpNextCardSkeleton />}>
          <CompanyUpNextSlot
            actorUserId={actor.id}
            companyId={companyId}
            companyName={companyName}
            footerLinks={footerLinks}
          />
        </Suspense>
        <div className="flex min-w-0 flex-col gap-4">
          {/* BAL-402: the company workspace's wallet card, streamed in after the rest of the page paints. */}
          <Suspense
            fallback={<WalletWidget state="loading" className={DASHBOARD_WALLET_SLOT_CLASS} />}
          >
            <DashboardWalletSlot actor={actor} companyId={companyId} />
          </Suspense>
        </div>
      </div>

      <Suspense fallback={<YourMoveSkeleton />}>
        <CompanyYourMoveSlot user={actor} companyId={companyId} companyName={companyName} />
      </Suspense>
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
  // ⚠ TRUTHINESS, not `!== undefined` — `resolveApprovedExpert()` (`lib/auth/approved-expert.ts`) gates on
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
