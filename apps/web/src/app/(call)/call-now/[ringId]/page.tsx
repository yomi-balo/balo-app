import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { checkSessionDrift } from '@/lib/auth/session-sync';
import { isRingId, resolveRingLandingPath } from '@/lib/call-now/resolve-ring-landing';

/**
 * The landing for the "call now" SMS link: `/call-now/{ringId}`. It renders nothing and redirects
 * to the call room while the ring is live, or to the case once it is over.
 *
 * Middleware requires the session and returns the viewer here after sign-in. A drifted session is
 * sent through session-sync and back here first (`(call)/layout.tsx` does not run the gate, and
 * the ring read forwards the session's Bearer). The api's
 * party-scoped ring read is the authorization, so a stranger's link resolves to `/cases`. A
 * `ringId` that is not a UUID goes to `/cases` before either step.
 *
 * `params` is a Promise in Next 16 and must be awaited.
 */
export const metadata: Metadata = {
  title: 'Opening your call — Balo',
  robots: { index: false, follow: false },
};

export default async function CallNowLandingPage({
  params,
}: Readonly<{ params: Promise<{ ringId: string }> }>): Promise<never> {
  const { ringId } = await params;
  if (!isRingId(ringId)) redirect('/cases');

  const drift = await checkSessionDrift();
  if (drift.action === 'sync-needed') {
    redirect(`/api/auth/session-sync?returnTo=${encodeURIComponent(`/call-now/${ringId}`)}`);
  }

  redirect(await resolveRingLandingPath(ringId));
}
