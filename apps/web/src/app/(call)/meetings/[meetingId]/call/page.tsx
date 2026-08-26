import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { checkSessionDrift } from '@/lib/auth/session-sync';
import { resolveInCallDrawdown } from '@/lib/credit/resolve-in-call-drawdown';
import { log } from '@/lib/logging';
import { meetingJoinLinkUrl } from '@/lib/meetings/join-link';
import { resolveMeetingChatAccess } from '@/lib/meetings/meeting-chat-anchor';
import { isRealtimeConfigured } from '@/lib/realtime/ably-server';
import { conversationChannelName } from '@/lib/realtime/channels';
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

/**
 * BAL-437 — ⚠⚠ **THE CHAT SLOT IS RESOLVED HERE, SERVER-SIDE, AND NOWHERE ELSE.**
 *
 * Two reasons it is not a client fetch:
 *   1. **No flash.** A Chat button that appears on mount and vanishes when the first token
 *      answer arrives is worse than one that was never there.
 *   2. **The slot rule.** BAL-435's rule is that an unregistered slot renders NOTHING, never a
 *      disabled control — which is only expressible if the answer is known before paint.
 *
 * ⚠⚠ IT NEVER FAILS THE CALL PAGE. Chat is an accessory to a live consultation; if the gate
 * throws we degrade to `hasChat: false` and log the reason. `warn`, not `error`: the call
 * proceeds, and a person who came to talk still gets to talk.
 *
 * ⚠ NO SESSION ⇒ NO GATE CALL AT ALL. `getCurrentUser()` above already degraded to `null` on a
 * session failure; asking the gate to authorize a `null` actor would be a second, weaker
 * opinion about a question that has already been answered.
 *
 * ⚠ A PURE-ISH MODULE HELPER RATHER THAN INLINE, ONLY TO SHED COGNITIVE COMPLEXITY — the
 * page's own body scored 16 against SonarCloud's allowed 15. The repo's precedent is to
 * EXTRACT, never to disable the rule.
 */
async function resolveChatSlot(
  meetingId: string,
  userId: string | null
): Promise<{ hasChat: boolean; chatChannelName: string | null }> {
  if (userId === null) return { hasChat: false, chatChannelName: null };

  try {
    const access = await resolveMeetingChatAccess({ meetingId, userId });
    if (!access.ok || access.anchor === null) {
      return { hasChat: false, chatChannelName: null };
    }
    return {
      hasChat: true,
      chatChannelName: conversationChannelName(access.anchor.conversationId),
    };
  } catch (error) {
    log.warn('Call page could not resolve the chat anchor', {
      meetingId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { hasChat: false, chatChannelName: null };
  }
}

/**
 * BAL-403 — ⚠⚠ **THE BALANCE SLOT IS RESOLVED HERE, SERVER-SIDE, MIRRORING `resolveChatSlot`.**
 *
 * ── ⚠⚠ FIX ROUND 2 (R1) — THE SLOT NOW RUNS THE **SAME COMPOSED GATE** AS THE PANEL BODY ─────
 *
 * Round 1 made this call `getSessionDrawdownState` directly — the SAME final read the panel
 * body used, but not the SAME GATE: the action also ran an audience gate first, and this RSC
 * did not. The two could disagree (see `resolve-in-call-drawdown.ts`'s docblock for the exact
 * failure this caused), so the slot now calls `resolveInCallDrawdown` — the ONE function
 * both this RSC and `get-meeting-drawdown-state.ts` call — and narrows its result to a boolean.
 * Registration and body read from the same three composed checks and cannot disagree by
 * construction. This also removes the double work round 1 left behind: the RSC used to derive a
 * full `DrawdownState` and discard everything but `!== null`, which the client's first poll then
 * redid milliseconds later.
 *
 * ⚠ BAL-466 (D3, D8) changed WHICH gate that first check is — `authorizeMeetingParticipation`,
 * not the company-audience gate — and reordered it to run FIRST. See
 * `resolve-in-call-drawdown.ts` for the full account.
 *
 * ── ⚠⚠ BAL-466 — "NO CREDIT SESSION FOR THIS MEETING" IS NOW THE ANSWER ONLY FOR NON-`case`
 *    MEETINGS AND A `case` WHOSE CLIENT HAS NOT YET BEEN ADMITTED ──────────────────────────
 *
 * `apps/web`'s `openSessionAction` (`lib/credit/actions/session-mutations.ts`) still has zero
 * non-test callers — the seam is server-side, NOT this web action. (`connectSessionAction` no
 * longer exists at all — F1 of the BAL-466 fix round deleted it: a `'presence'` session's
 * `pending → active` transition is system-only, driven by co-presence, and the actor-facing
 * `connectSession` now refuses one.) `joinMeetingAsMember` (`apps/api`) opens a
 * `duration_source='presence'` session
 * when the first CLIENT-side member is admitted to a `case` meeting, so `findIdByMeetingId` now
 * answers a real row for those meetings. This RSC still resolves BEFORE `joinAsMemberAction`
 * runs client-side (§A.6/§A.7 of the BAL-466 plan), so for the member whose join CREATES the
 * session, this verdict is stale `false` — `call-client.tsx`'s post-join probe re-resolves it.
 *
 * ⚠⚠ NEVER FAILS THE CALL PAGE, same posture as {@link resolveChatSlot}: Balance is an accessory
 * to a live consultation, so a throw degrades to `hasBalance: false` and logs a `warn`.
 */
async function resolveBalanceSlot(meetingId: string, userId: string | null): Promise<boolean> {
  if (userId === null) return false;

  try {
    return (await resolveInCallDrawdown(meetingId, userId)) !== null;
  } catch (error) {
    log.warn('Call page could not resolve the credit session', {
      meetingId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return false; // ⚠ NEVER fails the call page. Same posture as chat.
  }
}

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
  let userId: string | null = null;
  try {
    const user = await getCurrentUser();
    userId = user?.id ?? null;
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

  // ⚠ TWO INDEPENDENT SLOT RESOLUTIONS, RUN CONCURRENTLY — never a sequential waterfall for
  // unrelated reads (vercel-react-best-practices). Both degrade to `false` on their own; neither
  // can fail the other.
  const [{ hasChat, chatChannelName }, hasBalance] = await Promise.all([
    resolveChatSlot(meetingId, userId),
    resolveBalanceSlot(meetingId, userId),
  ]);

  return (
    <CallClient
      meetingId={meetingId}
      viewerName={viewerName}
      // ⚠⚠ BUILT SERVER-SIDE, TOKENLESS. See `meetingJoinLinkUrl` — including why the builder
      // lives in `lib/meetings/` rather than in this file.
      joinLinkUrl={meetingJoinLinkUrl(meetingId)}
      hasChat={hasChat}
      // BAL-403 / BAL-466 — ⚠⚠ G4 (second review round) — CORRECTING A NOW-FALSE CLAIM: this
      // used to say "`false` FOR EVERY MEETING TODAY, AND THAT IS EXPECTED". `true` is now the
      // real answer for a `case` meeting once its client has been admitted — see
      // `resolveBalanceSlot`'s docblock. `false` is still expected for every non-`case` meeting
      // and for a Case with no admitted client.
      hasBalance={hasBalance}
      // ⚠ THE ENV READ HAPPENS ON THE SERVER. `ABLY_API_KEY` is not `NEXT_PUBLIC_*` and must
      // never become one; the client only ever learns the BOOLEAN.
      isRealtimeEnabled={isRealtimeConfigured()}
      chatChannelName={chatChannelName}
    />
  );
}
