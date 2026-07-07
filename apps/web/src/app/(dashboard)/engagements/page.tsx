import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { log } from '@/lib/logging';
import { getCurrentUser } from '@/lib/auth/session';
import { isPlatformAdmin } from '@/lib/auth/is-admin';
import { loadEngagementsOversight } from '@/lib/engagements/engagements-oversight';
import type { EngagementsOversightDTO } from '@/lib/engagements/oversight-row';
import { EngagementsOversightShell } from './_components/engagements-oversight-shell';

/**
 * Admin engagements oversight list (BAL-335). Server Component:
 *  1. `getCurrentUser()` — null → `/login` (the unauthenticated edge; the
 *     (dashboard) layout already gates onboarding/drift).
 *  2. non-admin → `notFound()` — an admin-only surface that must not leak its
 *     existence to a client/expert (a 404 is indistinguishable from "no route").
 *  3. load the whole oversight DTO inside a try/catch that `log.error`s then
 *     re-throws to `error.tsx`.
 *  4. render the shell (which owns the filter + mounts the analytics island).
 */

export const metadata: Metadata = {
  title: 'Engagements — Balo',
  robots: { index: false, follow: false },
};

export default async function EngagementsPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (!isPlatformAdmin(user)) {
    notFound();
  }

  let dto: EngagementsOversightDTO;
  try {
    dto = await loadEngagementsOversight();
  } catch (error) {
    log.error('Failed to load engagements oversight', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // let error.tsx render the boundary
  }

  return <EngagementsOversightShell dto={dto} />;
}
