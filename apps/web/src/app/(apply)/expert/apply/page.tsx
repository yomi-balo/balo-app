import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { loadDraftAction } from './_actions/load-draft';
import { ExpertApplicationWizard } from './_components/expert-application-wizard';

export const metadata: Metadata = {
  title: 'Apply as Expert | Balo',
};

export default async function ExpertApplyPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) redirect('/login?returnTo=/expert/apply');
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
    <ExpertApplicationWizard
      draft={draft ?? null}
      referenceData={referenceData}
      user={{ id: user.id, email: user.email }}
    />
  );
}
