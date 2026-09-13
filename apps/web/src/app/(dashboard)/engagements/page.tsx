import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { log } from '@/lib/logging';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { loadEngagementsOversight } from '@/lib/engagements/engagements-oversight';
import type { EngagementsOversightDTO } from '@/lib/engagements/oversight-row';
import { EngagementsOversightShell } from './_components/engagements-oversight-shell';

/**
 * Admin engagements oversight list (BAL-335). Server Component:
 *  1. `getCurrentUser()` — null → `/login` (the unauthenticated edge; the
 *     (dashboard) layout already gates onboarding/drift).
 *  2. no `VIEW_PLATFORM_ADMIN` → `notFound()` — an admin-only surface that must not leak its
 *     existence (a 404 is indistinguishable from 'no route'). ⚠ The CAPABILITY (BAL-404), not
 *     the `isPlatformAdmin` role set: `/engagements` is a plain `(dashboard)` route, so
 *     middleware's `/admin`-prefix gate never runs and THIS is the only gate on the surface.
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
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
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
