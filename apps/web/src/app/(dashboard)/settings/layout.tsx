import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { resolveSettingsChrome } from './_lib/resolve-settings-chrome';
import { SettingsSectionNav } from './_components/settings-section-nav';

/**
 * BAL-503 — the client Settings shell. Async Server Component: resolves the session, then the
 * live `resolveSettingsChrome` chrome, and renders the tab bar (company workspace only) above
 * `{children}`.
 *
 * `getCurrentUser()` + explicit redirect — matching `settings/team/page.tsx`. NOT
 * `requireUser()`: that also throws on incomplete onboarding, which middleware already redirects
 * for on page navigations (workos-auth skill); throwing here would surface an error boundary
 * instead of the onboarding wizard.
 *
 * No width wrapper around `{children}` — `members-access-client.tsx` already applies its own
 * `mx-auto max-w-3xl`, and a second constraint here risks a visual regression on the untouchable
 * Team page. `SettingsSectionNav` carries its own `mx-auto w-full max-w-3xl`, and every NEW
 * section page wraps its own content the same way so the four sections align.
 */
export default async function SettingsLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  const chrome = await resolveSettingsChrome(user);

  return (
    <div className="flex flex-col gap-6">
      {chrome.showSectionNav && <SettingsSectionNav showTeamSection={chrome.showTeamSection} />}
      {children}
    </div>
  );
}
