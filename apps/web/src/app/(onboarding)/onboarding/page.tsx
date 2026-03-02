import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { OnboardingWizard } from './_components/onboarding-wizard';

export default async function OnboardingPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();

  if (!user) {
    redirect('/login');
  }

  if (user.onboardingCompleted) {
    redirect('/dashboard');
  }

  return <OnboardingWizard firstName={user.firstName} />;
}
