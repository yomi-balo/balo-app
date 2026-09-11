import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { loadReferenceData } from '@/lib/expert-apply/reference-data';
import { loadDraftAction } from './_actions/load-draft';
import { ExpertApplicationWizard } from './_components/expert-application-wizard';

export const metadata: Metadata = {
  title: 'Apply as Expert | Balo',
};

export default async function ExpertApplyPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();

  // ── Anonymous preview (BAL-502 §22). Public taxonomy only: no draft read, no
  // user. The auth wall sits at SUBMIT (step-terms), not here. Every `user.*`
  // access below lives inside the truthy branch, so this render can never
  // dereference a null user.
  if (!user) {
    const referenceData = await loadReferenceData();
    return <ExpertApplicationWizard draft={null} referenceData={referenceData} user={null} />;
  }

  if (!user.onboardingCompleted) redirect('/onboarding');

  const { draft, referenceData } = await loadDraftAction();

  // Already submitted -> success page
  if (
    draft?.profile.applicationStatus === 'submitted' ||
    draft?.profile.applicationStatus === 'under_review'
  ) {
    redirect('/expert/apply/success');
  }

  // Already approved -> dashboard
  if (draft?.profile.applicationStatus === 'approved') {
    redirect('/dashboard');
  }

  /*
    BAL-549 FIX ROUND (F1) — DEFENCE IN DEPTH, NOT THE FIX.

    A DECLINED applicant reaches this page by design: the decline email's CTA points straight
    at `/expert/apply`, and re-applying is allowed, so `'rejected'` renders the wizard prefilled
    with their own answers. That was previously an unremarked FALL-THROUGH, which is how the
    leak went unseen — the wizard is a `'use client'` boundary, so everything on `draft` is
    serialised into the applicant's own RSC flight payload.

    The real fix is the repository allow-list (`findApplicationWithRelations` no longer projects
    `decline_note` at all). This branch is the second layer: the decision METADATA is withheld
    too, because a re-application form has no use for any of it. `applicationStatus` stays —
    the wizard needs to know it is a re-application.
  */
  const applicantDraft =
    draft?.profile.applicationStatus === 'rejected'
      ? {
          ...draft,
          profile: {
            ...draft.profile,
            declineReason: null,
            decidedAt: null,
            decidedByUserId: null,
          },
        }
      : (draft ?? null);

  return (
    // FIX round (smaller item) — `{ id }` only, not `{ id, email }`: nothing under
    // `_components/` reads either field off `user` (only its nullness matters, for
    // `isAnonymous`), so the visitor's own email address is dead payload here.
    <ExpertApplicationWizard
      draft={applicantDraft}
      referenceData={referenceData}
      user={{ id: user.id }}
    />
  );
}
