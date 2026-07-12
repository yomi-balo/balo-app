import { redirect } from 'next/navigation';
import { classifyEmailDomain } from '@balo/shared/domains';
import { getCurrentUser } from '@/lib/auth/session';
import { checkSessionDrift } from '@/lib/auth/session-sync';
import { OnboardingWizard } from './_components/onboarding-wizard';
import { OnboardingReminderClickTracker } from './_components/onboarding-reminder-click-tracker';

interface OnboardingPageProps {
  searchParams: Record<string, string | string[] | undefined>;
}

/** Parse the reminder cadence step from the CTA (`?step=N`); clamp to 1|2|3, default 1. */
function parseCadenceStep(value: string | string[] | undefined): 1 | 2 | 3 {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === '2') return 2;
  if (raw === '3') return 3;
  return 1;
}

export default async function OnboardingPage({
  searchParams,
}: Readonly<OnboardingPageProps>): Promise<React.JSX.Element> {
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

  // BAL-374: a user who arrived via an onboarding-reminder email CTA
  // (`?src=onboarding_reminder&step=N`). The domain class is recomputed SERVER-SIDE from
  // the real email (never trusted from the URL, no persisted column); the client island
  // fires `onboarding_reminder_clicked` once per mount.
  const fromReminder = searchParams.src === 'onboarding_reminder';
  const reminderClick = fromReminder
    ? {
        cadenceStep: parseCadenceStep(searchParams.step),
        domainClass: classifyEmailDomain(user.email),
      }
    : null;

  return (
    <>
      {reminderClick && (
        <OnboardingReminderClickTracker
          cadenceStep={reminderClick.cadenceStep}
          domainClass={reminderClick.domainClass}
        />
      )}
      <OnboardingWizard firstName={user.firstName} authMethod={user.authMethod} />
    </>
  );
}
