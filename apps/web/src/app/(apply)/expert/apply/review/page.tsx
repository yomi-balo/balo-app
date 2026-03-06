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

  // Rejected → back to wizard (may reapply)
  if (result.application.profile.applicationStatus === 'rejected') {
    redirect('/expert/apply');
  }

  return (
    <ApplicationReview
      application={result.application}
      phone={result.phone}
      email={user.email}
      skillsByCategory={result.skillsByCategory}
      supportTypes={result.supportTypes}
      certificationsByCategory={result.certificationsByCategory}
    />
  );
}
