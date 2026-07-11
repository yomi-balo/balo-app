import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { checkSessionDrift } from '@/lib/auth/session-sync';
import { OnboardingWizard } from './_components/onboarding-wizard';

export default async function OnboardingPage(): Promise<React.JSX.Element> {
  // BAL-361: close the cross-tab residual gap. If this tab's cookie says
  // "not onboarded" but the DB row says otherwise (completed in another tab, or the
  // account was deleted/suspended), heal via session-sync instead of re-showing the
  // wizard. A genuinely un-onboarded user's DB matches the cookie → no drift → wizard.
  const drift = await checkSessionDrift();
  if (drift.action === 'sync-needed') {
    redirect('/api/auth/session-sync?returnTo=/dashboard');
  }

  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  if (user.onboardingCompleted) {
    redirect('/dashboard');
  }

  return <OnboardingWizard firstName={user.firstName} authMethod={user.authMethod} />;
}
