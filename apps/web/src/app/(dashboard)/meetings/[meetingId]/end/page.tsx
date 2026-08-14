import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { trackServerAndFlush, END_OF_CALL_SERVER_EVENTS } from '@/lib/analytics/server';
import { loadEndOfCall } from './_lib/load-end-of-call';
import { ClientEndOfCall } from './_components/client-end-of-call';
import { ExpertEndOfCall } from './_components/expert-end-of-call';

interface EndOfCallPageProps {
  /** ⚠ NEXT 16 — a PROMISE. It MUST be awaited; a sync interface silently no-ops. */
  params: Promise<{ meetingId: string }>;
}

/**
 * ⚠ STATIC, NOT `generateMetadata`, AND THAT IS BOTH SIMPLER AND STRICTLY SAFER. The recap needs
 * a `generateMetadata` that re-runs its FULL gate because its title echoes the meeting subject,
 * and Next streams the document title even when the body `notFound()`s. THIS SCREEN'S TITLE
 * NAMES NO SUBJECT, so there is nothing to authorise and nothing to leak. The wording is
 * deliberately neutral ("Meeting", not "Consultation") so the tab title does not disclose that
 * the meeting is a case. Precedent: `join/m/[meetingId]/page.tsx`, same posture, same reason.
 */
export const metadata: Metadata = {
  title: 'Meeting complete — Balo',
  robots: { index: false, follow: false },
};

/**
 * BAL-389 — THE END-OF-CALL SCREEN. The light, skippable way-station shown right after leaving a
 * session: it confirms the session completed, glances at the elapsed time, gives permission to
 * leave, and — client lens only — captures a rating and then, once a rating exists, offers to
 * resolve the case. One onward CTA, and nothing money-shaped.
 *
 * This screen is THROWAWAY. People do not linger, and many will close the tab and never see it,
 * so nothing mission-critical lives here — the receipt, the recap, the action items and every
 * conversion CTA are on the recap and in email. ONE QUALIFIED EXCEPTION: the case-resolution
 * prompt, which is consequential and irreversible, and is here anyway because asking at the
 * moment the client actually knows the answer is the whole point. Being consequential, it gets a
 * confirmation step — never a bare tap.
 *
 * ⚠ NEXT 16: `params` is a PROMISE and is awaited below. There is deliberately NO `searchParams`
 * prop: this screen reads no query string, and declaring a prop nothing reads is a promise the
 * file does not keep.
 *
 * ⚠⚠ NOTHING NAVIGATES HERE YET, AND THAT IS THE ONE DELIBERATELY-STUBBED BOUNDARY. **BAL-435**
 * owns the in-meeting route and the Leave handler, and supplies the producer with a one-line
 * `router.replace('/meetings/{id}/end')`. Everything else on this screen is live and
 * test-exercised: the gate, the loader, the rating read, the rating write, the close, the close
 * gate, both analytics events and all four route states. Do NOT add an entry point here — no
 * redirect from another route, no dev-only "simulate leave" button, no link from the recap, the
 * lobby, the dashboard or `MeetingCallSurface`. Shipping an entry point that dead-ends at
 * "Connecting…" is exactly what `join-as-member.ts`'s docblock forbids.
 *
 * ⚠⚠ THERE IS NO REJOIN AFFORDANCE, AND ITS ABSENCE IS AN EXPLICIT OWNER DECISION — the ONE
 * deviation from the design reference's element list, and a ROUTING FACT rather than a design
 * judgement. `/join/m/[meetingId]` is the ANONYMOUS lobby: routing a signed-in, already-
 * authorised member there would enqueue them through the GUEST identity-claim path. The member
 * arm, `join/_actions/join-as-member.ts`, has no caller BY DESIGN and names BAL-435 as its
 * consumer. And both arms terminate at `MeetingCallSurface`'s "Connecting…" placeholder, because
 * no Daily SDK ships in `apps/web`. BAL-435 adds the button, its destination and its
 * `EndOfCallAction` value together; `'rejoin'` is therefore NOT declared today, and
 * `end-of-call.test.ts` pins its absence by name.
 *
 * ⚠ ONE `notFound()` WITH ONE COPY for missing, soft-deleted, unauthorised, declined, ambiguous
 * AND ADMIN-CONTEXT meetings. A distinct 403 would confirm the meeting exists, which makes the
 * page an existence oracle over every `meetings.id` on the platform.
 *
 * ⚠ THE LENS BRANCH IS A COMPOSITION BRANCH, NOT A CONDITIONAL RENDER. `ExpertEndOfCall` never
 * imports the rating block or the resolve prompt, so client-only copy cannot leak through a bug
 * in a flag.
 */
export default async function EndOfCallPage({
  params,
}: Readonly<EndOfCallPageProps>): Promise<React.JSX.Element> {
  const { meetingId } = await params;

  // The (dashboard) layout gates onboarding/drift; guard the unauthenticated case explicitly so
  // a missing session redirects rather than 500s.
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  let view: Awaited<ReturnType<typeof loadEndOfCall>>;
  try {
    view = await loadEndOfCall(meetingId, user.id);
  } catch (error) {
    log.error('Failed to load end-of-call screen', {
      meetingId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error; // let error.tsx render the boundary
  }

  if (view === null) {
    // The gate already logged the DENIAL SHAPE. One copy on the wire.
    notFound();
  }

  // ⚠ `null` ON THE EXPERT LENS — the rating is structurally absent there, not merely hidden.
  const ratingState = view.lens === 'client' ? (view.rating?.state.kind ?? null) : null;

  // Server-side truth at FIRST PAINT. A later client-side reveal (the rate-first ordering rule)
  // is deliberately NOT re-tracked as a second view — it is already legible as
  // `end_of_call_action: 'rated'` followed by `case_resolved{source:'end_of_call'}`.
  const resolvePromptShown =
    view.lens === 'client' &&
    view.resolve !== null &&
    !view.resolve.alreadyClosed &&
    ratingState !== null &&
    ratingState !== 'none';

  // Registered on the authorised path, BEFORE the lens branch and before any later throw, so the
  // flush lands on serverless even if the render fails downstream.
  trackServerAndFlush(END_OF_CALL_SERVER_EVENTS.VIEWED, {
    recap_state: view.recapState,
    rating_state: ratingState,
    resolve_prompt_shown: resolvePromptShown,
    context_type: view.contextType,
    lens: view.lens,
    distinct_id: user.id,
  });

  if (view.lens === 'client') {
    return <ClientEndOfCall view={view} />;
  }
  return <ExpertEndOfCall view={view} />;
}
