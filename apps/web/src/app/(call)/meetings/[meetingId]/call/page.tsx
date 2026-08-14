import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { checkSessionDrift } from '@/lib/auth/session-sync';
import { log } from '@/lib/logging';
import { meetingJoinLinkUrl } from '@/lib/meetings/join-link';
import { CallClient } from './_components/call-client';

/**
 * BAL-435 — the AUTHENTICATED MEMBER's in-call route: `/meetings/{meetingId}/call`.
 *
 * ⚠⚠ IT IS A SIBLING OF BAL-388's RECAP, NOT A REPLACEMENT FOR IT. `(dashboard)/meetings/
 * [meetingId]/page.tsx` is the post-meeting recap and is NOT touched. Route groups do not affect
 * the URL, so `/meetings/{id}` stays the recap and `/meetings/{id}/call` is the live call —
 * which makes "leave → recap" a natural parent navigation inside ONE url family.
 *
 * ⚠ WHAT WOULD CONFLICT, STATED SO NOBODY TRIES IT: `(call)/meetings/[meetingId]/page.tsx` (no
 * `/call` suffix) resolves to the SAME URL as the recap and Next rejects it. The `/call` child is
 * the whole reason this works.
 *
 * ⚠ `params` IS A **PROMISE** — this app is on Next 16 and it must be awaited.
 *
 * ── ⚠⚠ THE SESSION-DRIFT GATE LIVES **HERE**, NOT IN `(call)/layout.tsx`, AND THAT IS THE FIX ─
 *
 * `(dashboard)/layout.tsx` runs `checkSessionDrift()` before anything renders, and this route
 * group exists precisely so the call does NOT inherit that layout. But the gate is not
 * decoration: `postMemberJoin` forwards `session.accessToken` as a Bearer to `apps/api`, so a
 * drifted session carries a STALE token, the member join 401s, and a valid participant is shown
 * "This meeting isn't available to join" at the moment they are trying to enter a paid call.
 *
 * The layout copied the eight lines verbatim — INCLUDING `headers().get('x-invoke-path')`, which
 * **DOES NOT EXIST IN NEXT 16**. That read always returned `null`, so `returnTo` was always
 * `/dashboard`: a drifted member was silently bounced to their dashboard instead of back into the
 * call. A layout cannot know a child segment's params, so the gate belongs in the page, which
 * has `meetingId` in hand and can name the exact destination.
 *
 * ⚠ IT IS NOT AUTHORIZATION. Middleware requires the session; `apps/api`'s
 * `authorizeMeetingParticipation` decides who may join. A read here would be a second, weaker
 * opinion.
 */

export const metadata: Metadata = {
  title: 'In the call — Balo',
  // ⚠ A live call must never be indexed, and its URL carries a meeting id.
  robots: { index: false, follow: false },
};

export default async function MeetingCallPage({
  params,
}: Readonly<{ params: Promise<{ meetingId: string }> }>): Promise<React.JSX.Element> {
  const { meetingId } = await params;

  const drift = await checkSessionDrift();
  if (drift.action === 'sync-needed') {
    // ⚠ BACK INTO THE CALL, not to the dashboard. `getSafeRedirectPath` re-checks this
    // server-side (same origin, no auth paths), so a same-origin literal is the safe shape.
    const returnTo = `/meetings/${meetingId}/call`;
    redirect(`/api/auth/session-sync?returnTo=${encodeURIComponent(returnTo)}`);
  }

  // ⚠ NAME ONLY, AND ONLY FOR PreJoin's "Joining as …" LINE. Never the email, never the id.
  let viewerName: string | null = null;
  try {
    const user = await getCurrentUser();
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
    viewerName = name.length === 0 ? null : name;
  } catch (error) {
    // ⚠ A missing session is NOT fatal here: `joinAsMemberAction` re-gates with
    // `requireOnboardedUser()` and the api re-verifies the token independently. PreJoin simply
    // omits the identity line rather than guessing one.
    // ⚠ BUT THE REASON IS KEPT (CLAUDE.md: `log` in every catch that HANDLES rather than
    // re-throws). Degrading `viewerName` is right; discarding WHY is how a systematic session
    // failure stays invisible. `warn`, not `error`: the call still proceeds.
    log.warn('Call page could not resolve the viewer name', {
      meetingId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }

  return (
    <CallClient
      meetingId={meetingId}
      viewerName={viewerName}
      // ⚠⚠ BUILT SERVER-SIDE, TOKENLESS. See `meetingJoinLinkUrl` — including why the builder
      // lives in `lib/meetings/` rather than in this file.
      joinLinkUrl={meetingJoinLinkUrl(meetingId)}
    />
  );
}
