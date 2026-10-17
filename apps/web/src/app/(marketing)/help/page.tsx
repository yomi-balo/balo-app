import type { Metadata } from 'next';
import { getCurrentUser, type SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { defaultHelpAudience, parseHelpSide } from '@/lib/help/audience';
import { helpContent } from '@/lib/help/content';
import { HelpIndexView } from './_components/help-index-view';

export const metadata: Metadata = {
  title: 'Balo help — Balo',
  description: 'Step-by-step guides for using Balo. Pick whether you hire experts or work as one.',
};

interface HelpIndexPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * The side the page opens on is presentation only (never authorization), so a failed session
 * read fails open to the signed-out, client-side default.
 */
async function readUser(): Promise<SessionUser | null> {
  try {
    return await getCurrentUser();
  } catch (error) {
    log.warn('Help index session read failed; defaulting to clients', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export default async function HelpIndexPage({
  searchParams,
}: Readonly<HelpIndexPageProps>): Promise<React.JSX.Element> {
  const params = await searchParams;
  const user = await readUser();
  const initialAudience = parseHelpSide(params.for) ?? defaultHelpAudience(user);

  return (
    <HelpIndexView
      initialAudience={initialAudience}
      groups={{
        client: helpContent.listCategories('client'),
        expert: helpContent.listCategories('expert'),
      }}
      signedIn={user !== null}
    />
  );
}
