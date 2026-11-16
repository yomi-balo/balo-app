import { redirect } from 'next/navigation';
import { usersRepository } from '@balo/db';
import { getCurrentUser } from '@/lib/auth/session';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { AccountNameSection } from './_components/account-name-section';
import { ClientSmsSection } from './_components/client-sms-section';

/**
 * The personal Account page — the nav registry's `account` entry (sidebar + mobile More sheet)
 * and the user menu both land here, in either workspace. Everything on it belongs to the PERSON,
 * never the workspace, so it reads no company or capability. No `h1` — the breadcrumb owns it.
 *
 * Text-alert consent is personal, so an impersonated session neither reads nor shows it. The name
 * and consent are read from the database, not the session cookie: the cookie
 * is sealed at sign-in and can lag a change made on another device.
 */
export default async function AccountSettingsPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  const impersonated = isImpersonatedSession(user);
  const [profile, smsConsent] = await Promise.all([
    usersRepository.findDisplayById(user.id),
    impersonated ? undefined : usersRepository.findClientSmsConsent(user.id),
  ]);
  const verifiedPhone = smsConsent?.phone && smsConsent.phoneVerifiedAt ? smsConsent.phone : null;
  const optedIn = verifiedPhone !== null && Boolean(smsConsent?.clientSmsOptedInAt);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <AccountNameSection
        initialFirstName={profile?.firstName ?? user.firstName ?? ''}
        initialLastName={profile?.lastName ?? user.lastName ?? ''}
      />
      {!impersonated && (
        <ClientSmsSection
          verifiedPhone={verifiedPhone}
          optedIn={optedIn}
          sharesExpertNumber={user.expertProfileId !== undefined}
        />
      )}
    </div>
  );
}
