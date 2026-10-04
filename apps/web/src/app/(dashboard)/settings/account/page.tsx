import { redirect } from 'next/navigation';
import { usersRepository } from '@balo/db';
import { getCurrentUser } from '@/lib/auth/session';
import { AccountNameSection } from './_components/account-name-section';

/**
 * The personal Account page — the nav registry's `account` entry (sidebar + mobile More sheet)
 * and the user menu both land here, in either workspace. Everything on it belongs to the PERSON,
 * never the workspace, so it reads no company or capability. No `h1` — the breadcrumb owns it.
 *
 * The name is read from the database, not the session cookie: the cookie is sealed at sign-in
 * and can lag a change made on another device.
 */
export default async function AccountSettingsPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  const profile = await usersRepository.findDisplayById(user.id);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <AccountNameSection
        initialFirstName={profile?.firstName ?? user.firstName ?? ''}
        initialLastName={profile?.lastName ?? user.lastName ?? ''}
      />
    </div>
  );
}
