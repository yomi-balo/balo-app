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

  return (
    // FIX round (smaller item) — `{ id }` only, not `{ id, email }`: nothing under
    // `_components/` reads either field off `user` (only its nullness matters, for
    // `isAnonymous`), so the visitor's own email address is dead payload here.
    <ExpertApplicationWizard
      draft={draft ?? null}
      referenceData={referenceData}
      user={{ id: user.id }}
    />
  );
}
