import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { z } from 'zod';
import { expertsRepository, referenceDataRepository, usersRepository } from '@balo/db';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { getCurrentUser } from '@/lib/auth/session';
import { personWithOrgLabel } from '@balo/shared/parties';
import { EntityCrumb } from '@/components/layout/breadcrumb-context';
import { applicationWaitingDays } from '@balo/shared/experts';
import { formatWaitingLabel } from '../_lib/application-list-view';
import { ApplicationSections } from '../_components/application-sections';
import { DecisionOutcomeBanner } from '../_components/decision-outcome-banner';
import { DecisionControls } from '../_components/decision-controls';

/**
 * BAL-549 — the expert-application review page.
 *
 *  1. Same two gates as the list page.
 *  2. `profileId` is validated as a uuid BEFORE any repository call — an invalid id is a plain
 *     `notFound()`, never a query against garbage.
 *  3. `findApplicationForStaffReview` — `undefined` → `notFound()`.
 *  4. `DecisionControls` render when and only when the application is `'submitted'` or
 *     `'under_review'` (D4).
 *  5. `DecisionOutcomeBanner` renders when the application is already decided — the decider's
 *     name is hydrated with the SHIPPED narrow read (`usersRepository.findNamesByIds`), never a
 *     new repository method, and never by widening `findApplicationWithRelations`'s `with:` (that
 *     read is also the applicant's own — hydrating a staffer onto it would be a leak).
 *
 * ⚠⚠ TWO DIFFERENT TOKENS, DELIBERATELY (FIX ROUND F2/F12). The PAGE READ is gated on
 * `VIEW_PLATFORM_ADMIN` — D1 says so, and it is the token `admin/layout.tsx` and the middleware
 * already enforce. The staff-only `decline_note` RENDER is gated SEPARATELY on
 * `REVIEW_EXPERT_APPLICATIONS`, the token whose own docblock claims it covers reading the note.
 * Both tokens sit in `PLATFORM_STAFF_BUNDLE` today, so no holder can tell the difference — the
 * split exists so the D5 bundle split cannot silently hand a view-only staff role a note that
 * was never meant for it, and so the two capability docblocks stop vouching for a gate that
 * nothing enforced.
 *
 * ⚠ `findApplicationForStaffReview` IS THE ONLY READ THAT CARRIES THE NOTE. The applicant's own
 * `findApplicationWithRelations` does not project the column at all (fix-round F1), so the page
 * gate and the repository projection fail closed independently.
 */

export const metadata: Metadata = {
  title: 'Application review — Balo',
  robots: { index: false, follow: false },
};

interface AdminApplicationReviewPageProps {
  params: Promise<{ profileId: string }>;
}

export default async function AdminApplicationReviewPage({
  params,
}: Readonly<AdminApplicationReviewPageProps>): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    notFound();
  }

  const { profileId: rawProfileId } = await params;
  const parsedProfileId = z.uuid().safeParse(rawProfileId);
  if (!parsedProfileId.success) {
    notFound();
  }
  const profileId = parsedProfileId.data;

  const [application, vertical] = await Promise.all([
    expertsRepository.findApplicationForStaffReview(profileId),
    referenceDataRepository.getSalesforceVertical(),
  ]);

  if (application === undefined) {
    notFound();
  }

  const [productsByCategory, supportTypes, certificationsByCategory] = await Promise.all([
    referenceDataRepository.getProductsByVertical(vertical.id),
    referenceDataRepository.getSupportTypes(vertical.id),
    referenceDataRepository.getCertificationsByVertical(vertical.id),
  ]);

  const { profile, user: applicant, agency } = application;
  // ⚠ THE SECOND TOKEN — resolved here, not inherited from the page gate above (F2/F12).
  const canReadNote = hasPlatformCapability(user, PLATFORM_CAPABILITIES.REVIEW_EXPERT_APPLICATIONS);
  const isPending =
    profile.applicationStatus === 'submitted' || profile.applicationStatus === 'under_review';
  const isDecided =
    profile.applicationStatus === 'approved' || profile.applicationStatus === 'rejected';

  let decidedByFirstName: string | null = null;
  let decidedByLastName: string | null = null;
  if (isDecided && profile.decidedByUserId !== null) {
    const [decider] = await usersRepository.findNamesByIds([profile.decidedByUserId]);
    decidedByFirstName = decider?.firstName ?? null;
    decidedByLastName = decider?.lastName ?? null;
  }

  const applicantName = personWithOrgLabel(
    [applicant.firstName, applicant.lastName].filter(Boolean).join(' ') || applicant.email,
    agency?.name ?? null
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {/* BAL-499 — publishes the applicant's name into the top bar's breadcrumb trail. */}
      <EntityCrumb label={applicantName} />

      {/*
        FIX ROUND F20 — an EXPLICIT back link, because the shell cannot supply one here.
        `resolveBreadcrumbTrail('/admin/applications/{id}')` returns `[]` (its first segment,
        `admin`, has no `ENTITY_PARENTS` entry), so `Breadcrumbs` renders a single href-less
        crumb and suppresses its mobile back arrow. Desktop staff still have the
        `AdminSectionNav` chip; a mobile viewer deep-linked from a queue row had no route back.
      */}
      <Link
        href="/admin/applications"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -ml-1 inline-flex min-h-[44px] w-fit items-center gap-1.5 rounded-lg text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {/* pending-MJ */}
        Back to applications
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-foreground text-2xl font-semibold">{applicantName}</h2>
          <p className="text-muted-foreground text-sm">
            {applicant.email} · {agency?.name ?? 'Independent'}
            {isPending && (
              <> · {formatWaitingLabel(applicationWaitingDays(profile.submittedAt, new Date()))}</>
            )}
          </p>
        </div>
        {isPending && (
          <DecisionControls
            expertProfileId={profileId}
            firstName={applicant.firstName || applicant.lastName || applicant.email}
          />
        )}
      </div>

      {isDecided && profile.decidedAt !== null && (
        <DecisionOutcomeBanner
          decision={profile.applicationStatus === 'approved' ? 'approved' : 'declined'}
          decidedByFirstName={decidedByFirstName}
          decidedByLastName={decidedByLastName}
          decidedAt={profile.decidedAt}
          declineReason={profile.declineReason}
          declineNote={canReadNote ? profile.declineNote : null}
        />
      )}

      <ApplicationSections
        application={application}
        productsByCategory={productsByCategory}
        supportTypes={supportTypes}
        certificationsByCategory={certificationsByCategory}
      />
    </div>
  );
}
