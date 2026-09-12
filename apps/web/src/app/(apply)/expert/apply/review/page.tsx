import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { loadSubmittedApplication } from '../_actions/load-submitted';
import { ApplicationReview } from './_components/application-review';

export const metadata: Metadata = {
  title: 'Your Application | Balo',
};

export default async function ApplicationReviewPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) redirect('/login?returnTo=/expert/apply/review');
  if (!user.onboardingCompleted) redirect('/onboarding');

  const result = await loadSubmittedApplication();

  // No application or still draft → back to wizard
  if (!result || result.application.profile.applicationStatus === 'draft') {
    redirect('/expert/apply');
  }

  // Already approved → dashboard
  if (result.application.profile.applicationStatus === 'approved') {
    redirect('/dashboard');
  }

  /*
    Rejected → back to the wizard, which is where a declined applicant's own answers are shown.

    ⚠ NOT "because they may reapply" (web-review fix round, W1). This comment used to say so;
    re-submitting is refused (`submitApplication` accepts `'draft'` only) and a follow-up ticket
    owns the real transition. This read-only review page has nothing to show for a closed
    application, so the redirect stands on its own — behaviour deliberately unchanged.
  */
  if (result.application.profile.applicationStatus === 'rejected') {
    redirect('/expert/apply');
  }

  return (
    <ApplicationReview
      application={result.application}
      email={user.email}
      productsByCategory={result.productsByCategory}
      supportTypes={result.supportTypes}
      certificationsByCategory={result.certificationsByCategory}
    />
  );
}
