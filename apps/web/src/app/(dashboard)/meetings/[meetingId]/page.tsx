import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { trackServerAndFlush, RECAP_SERVER_EVENTS } from '@/lib/analytics/server';
import type { RecapEntrySource } from '@balo/analytics/events';
import { EntityCrumb } from '@/components/layout/breadcrumb-context';
import { loadRecap } from './_lib/load-recap';
import { deriveRecordingState } from './_lib/map-recap-recordings';
import { ClientRecap } from './_components/client-recap';
import { ExpertRecap } from './_components/expert-recap';

interface RecapPageProps {
  /** ⚠ NEXT 16 — `params` AND `searchParams` ARE PROMISES. They MUST be awaited. */
  params: Promise<{ meetingId: string }>;
  searchParams: Promise<{ from?: string }>;
}

/**
 * Generic, leak-free metadata for any viewer who is not an authorised participant of this
 * meeting (or when it is missing). It must not echo the real title or otherwise confirm the
 * meeting exists.
 */
const GENERIC_METADATA: Metadata = {
  title: 'Meeting recap — Balo',
  robots: { index: false, follow: false },
};

/**
 * Whitelist `?from` into the analytics entry union. Anything unrecognised ⇒ `direct`.
 *
 * ⚠ EVERY ACCEPTED VALUE HAS A LIVE PRODUCER, AND THIS WHITELIST IS HALF OF WHAT MAKES THAT
 * TRUE. Declaring a value in `RecapEntrySource` WITHOUT adding its arm here would silently
 * collapse it to `direct` and ship a declared-but-never-emitted dimension — precisely what
 * `packages/analytics/src/events/recap.ts` forbids. The two edits belong to the same ticket,
 * always:
 *   · `notification` — both recap deep links (`recap-ready` and `engagement.case_closed`,
 *     email and in-app) append it.
 *   · `case_surface` — ADDED BY BAL-421, the ticket that emits it. Every consultation row on
 *     `/cases/{engagementId}` links here as `/meetings/{id}?from=case_surface` (see
 *     `cases/[engagementId]/_lib/map-case-consultations.ts`). Before that surface existed this
 *     arm was unreachable and was correctly absent.
 *   · `end_of_call` — ADDED BY BAL-389, the ticket that emits it. The end-of-call screen's
 *     ready-state CTA links here as `/meetings/{id}?from=end_of_call`.
 *
 * ⚠ THE MAP IS THE WHITELIST. An unknown `?from` falls through to `direct` rather than being
 * passed along, so a hand-typed or crafted query string can never widen the union at runtime.
 */
const ENTRY_SOURCE_BY_PARAM: Readonly<Record<string, RecapEntrySource>> = {
  notification: 'notification',
  case_surface: 'case_surface',
  end_of_call: 'end_of_call',
};

function resolveEntrySource(from: string | undefined): RecapEntrySource {
  if (from === undefined) return 'direct';
  // ⚠ `Object.hasOwn`, NOT a bare lookup — an object-literal index resolves INHERITED keys, so
  // `?from=constructor` would otherwise yield the `Object` constructor typed as an entry source
  // (the same trap `parsePrefillRating`'s docblock names in `@balo/shared/reviews`).
  if (!Object.hasOwn(ENTRY_SOURCE_BY_PARAM, from)) return 'direct';
  return ENTRY_SOURCE_BY_PARAM[from] ?? 'direct';
}

export async function generateMetadata({ params }: Readonly<RecapPageProps>): Promise<Metadata> {
  const { meetingId } = await params;

  // Mirror the page body's gating BEFORE specialising the title: Next streams the document
  // title even when the body `notFound()`s, so authorising here is what stops a
  // non-participant learning the meeting's subject or its existence. The cached loader dedupes
  // with the page body — no extra DB cost.
  try {
    const user = await getCurrentUser();
    if (!user) return GENERIC_METADATA;

    const view = await loadRecap(meetingId, user.id);
    if (view === null) return GENERIC_METADATA;

    return {
      title: view.header.title + ' — Balo',
      robots: { index: false, follow: false },
    };
  } catch {
    // Metadata is best-effort — the page itself surfaces load failures. Fall back to the
    // generic (leak-free) title rather than echoing anything.
    return GENERIC_METADATA;
  }
}

/**
 * BAL-388 — THE POST-MEETING RECAP. The durable artefact a client or expert lands on after a
 * consultation: what happened, what it cost or earned, what is now theirs to do, and — for a
 * client on an open case — the one decision that only ever feels natural right here.
 *
 * ⚠ NEXT 16: `params` and `searchParams` are PROMISES and are awaited above.
 *
 * ⚠ ONE `notFound()` WITH ONE COPY for missing, soft-deleted, unauthorised, declined,
 * ambiguous AND ADMIN-CONTEXT meetings. A distinct 403 would confirm the meeting exists, which
 * makes the page an existence oracle over every `meetings.id` on the platform.
 *
 * ⚠ ADMIN-CONTEXT MEETINGS 404, and there is deliberately NO admin branch anywhere in this
 * feature — `selectPrimaryMeetingContext` drops `admin` rows, so the gate denies them before
 * anything renders. Admin meetings resolve on the PLATFORM axis (ADR-1035), out of scope here.
 * See `resolve-recap-access.ts`.
 *
 * ⚠ THE LENS BRANCH IS A COMPOSITION BRANCH, NOT A CONDITIONAL RENDER. `ExpertRecap` never
 * imports the resolve prompt or the wrap-up card, so client-only copy cannot leak through a
 * bug in a flag.
 */
export default async function RecapPage({
  params,
  searchParams,
}: Readonly<RecapPageProps>): Promise<React.JSX.Element> {
  const { meetingId } = await params;

  // The (dashboard) layout gates onboarding/drift; guard the unauthenticated case explicitly
  // so a missing session redirects rather than 500s.
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  let view: Awaited<ReturnType<typeof loadRecap>>;
  try {
    view = await loadRecap(meetingId, user.id);
  } catch (error) {
    log.error('Failed to load meeting recap', {
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

  const { from } = await searchParams;
  const resolveVariant = view.lens === 'client' ? view.resolve.variant : 'none';

  // Registered on the authorised path, BEFORE any later throw, so the flush lands on
  // serverless even if the render fails downstream.
  trackServerAndFlush(RECAP_SERVER_EVENTS.RECAP_VIEWED, {
    recap_state: view.state,
    context_type: view.contextType,
    lens: view.lens,
    source: resolveEntrySource(from),
    resolve_prompt_shown: resolveVariant !== 'none',
    resolve_prompt_variant: resolveVariant,
    // BAL-440 — the meeting's recording posture at render time, so
    // `recap_recording_played ÷ recap_viewed` is answerable BY STATE.
    recording_state: deriveRecordingState(view.recordings),
    distinct_id: user.id,
  });

  // BAL-499 — publishes the meeting's title into the top bar's breadcrumb trail on BOTH lens
  // branches. Safe here: this is the already-authorised return path, after every gate above.
  if (view.lens === 'client') {
    return (
      <>
        <EntityCrumb label={view.header.title} />
        <ClientRecap view={view} />
      </>
    );
  }
  return (
    <>
      <EntityCrumb label={view.header.title} />
      <ExpertRecap view={view} />
    </>
  );
}
