import type { MeetingOutcome, MeetingStatus } from '@balo/db';
import type { RecapLens, RecapState } from '@balo/analytics/events';
import type {
  RecapArtifactState,
  RecapArtifactsView,
  RecapMoneyView,
  RecapNotHeldView,
  SessionMoneyBlock,
} from '@/lib/meetings/recap-view-types';
import { NOBODY_JOINED_NOTE } from '@/lib/meetings/nobody-joined-copy';
import { VENUE_UNAVAILABLE_RECAP_BODY } from '@/lib/meetings/venue-unavailable-copy';

/**
 * BAL-388 — the recap's PURE state machine: outcome (§R11), artefacts (§R5 / §R7), Rule M
 * (§R3), and the single `recap_state` analytics value. No I/O, no clock, no `db`.
 *
 * Everything here is a pure function precisely because the states that matter most are the
 * ones production cannot reach yet: there is no `meeting_outcome` writer (BAL-134) and no
 * production enqueuer for the transcript pipeline, so the ONLY thing that can prove the
 * not-held and artefact-absent renders work is a unit test over these functions.
 */

/** `transcripts.status`, mirrored as a plain union so this module stays `@balo/db`-value-free. */
export type TranscriptStatusLike = 'processing' | 'ready' | 'failed';

export interface ArtifactsInput {
  /** `null` ⇒ NO transcript row exists for this meeting at all. */
  transcriptStatus: TranscriptStatusLike | null;
  /** `transcript_artifacts` `kind='summary'` content. */
  summaryContent: string | null;
  /** `transcript_artifacts` `kind='cleaned'` content. */
  transcriptContent: string | null;
  /**
   * TRUE when a pipeline run is still plausible for this meeting (it ended recently and no
   * transcript row has appeared yet). Injected rather than computed, so the derivation stays
   * clock-free and deterministic under test.
   */
  awaitingPipeline: boolean;
}

/**
 * ⚠ AN ARTEFACT WHOSE CONTENT IS THE EMPTY STRING RENDERS THE **ABSENT** BRANCH, NOT AN EMPTY
 * CARD. An empty card reads as a bug; the absent copy reads as a fact. This is the single
 * place that normalisation happens.
 */
function contentState(content: string | null): {
  state: RecapArtifactState;
  content: string | null;
} {
  const trimmed = content?.trim() ?? '';
  if (trimmed.length === 0) {
    return { state: 'absent', content: null };
  }
  return { state: 'ready', content: trimmed };
}

/**
 * Resolve the summary and transcript sections, plus whether they COLLAPSE into one card.
 *
 * ⚠ THE COLLAPSE RULE IS A COMPOSITION DECISION, NOT AN ACCIDENT: when NEITHER section has
 * anything to show, the page renders ONE card ("this call was not written up") instead of two
 * sad stacked ones. Action items still render in full between it and the rail. Processing is
 * deliberately EXCLUDED from the collapse — a skeleton is a promise, not an absence.
 */
export function resolveArtifacts(input: ArtifactsInput): RecapArtifactsView {
  const { transcriptStatus, summaryContent, transcriptContent, awaitingPipeline } = input;

  if (transcriptStatus === 'failed') {
    return {
      summary: { state: 'failed', content: null },
      transcript: { state: 'failed', content: null },
      collapsed: true,
    };
  }

  const stillComing =
    transcriptStatus === 'processing' || (transcriptStatus === null && awaitingPipeline);
  if (stillComing) {
    return {
      summary: { state: 'processing', content: null },
      transcript: { state: 'processing', content: null },
      collapsed: false,
    };
  }

  const summary = contentState(summaryContent);
  const transcript = contentState(transcriptContent);
  return {
    summary,
    transcript,
    collapsed: summary.state !== 'ready' && transcript.state !== 'ready',
  };
}

/**
 * RULE M — the money line, keyed on the PRESENCE of a `credit_sessions` row. THREE STATES,
 * across TWO branches (M2 and M3 are one arm here — see below).
 *
 *   M1 — no row      ⇒ `{ kind: 'absent' }`. ONE muted line, no figure, no explanation, and
 *                       NEVER a negation ("you were not charged" is a claim about billing
 *                       RULES that BAL-412 can falsify; absence-of-record cannot be).
 *   M2 — row pending ⇒ the shipped fragment's pending affordance (elapsed only).
 *   M3 — row final   ⇒ the shipped fragment's finalized figure.
 *
 * M2 and M3 are ONE arm here on purpose: the branch between them belongs to the fragment,
 * which already owns it along with its loading and error states. A `null` block is the
 * fragment's OWN muted fallback — do not add a second error state around it.
 *
 * ⚠ A CANCELLED SESSION IS NOT A ROW FOR THIS PURPOSE. `findIdByMeetingId` EXCLUDES
 * `status = 'cancelled'`: a cancelled session never finalizes billing, so `deriveState` would
 * map its null `billing_finalized_at` to `pending` and the recap would read "Charge pending"
 * forever. A meeting whose only session was cancelled therefore falls to M1.
 *
 * ⚠ NO POLICY PROSE, NO MINIMUM, NO FLOOR, EVER. BAL-412 SHIPPED a 15-minute billing floor and
 * BAL-466 made it reachable — and this page still does not state it. The figure the fragment
 * renders is already floor-inclusive; restating the policy would be a claim this page cannot
 * recompute (the floor is env-resolvable in `apps/api` alone), and a stale one the day it
 * changes.
 *
 * `clientSideEverPresent` rides the session arm untouched: the fragment's `missed_call` line
 * names the consultant unless it is a KNOWN `false`. A session is no proof the client side
 * joined — it opens when the call page mints a join grant, before anyone connects.
 */
export function resolveMoneyView(input: {
  hasSession: boolean;
  block: SessionMoneyBlock | null;
  elapsedMinutes: number;
  clientSideEverPresent: boolean | null;
}): RecapMoneyView {
  if (!input.hasSession) {
    return { kind: 'absent' };
  }
  return {
    kind: 'session',
    block: input.block,
    elapsedMinutes: input.elapsedMinutes,
    clientSideEverPresent: input.clientSideEverPresent,
  };
}

export interface NotHeldInput {
  status: MeetingStatus;
  outcome: MeetingOutcome | null;
  lens: RecapLens;
  /** Retrospective, person @ agency on first mention — the EXPERT's label. */
  expertPersonLabel: string;
  /** Prospective — the client COMPANY's name. Client-side absence names the PARTY. */
  clientCompanyName: string;
  /**
   * `summarisePresence(...).clientSideEverPresent`, or `null` when presence was not read or the
   * read failed. Consulted on `missed_call` only. ⚠ `null` IS UNKNOWN, NOT ABSENT — only a
   * KNOWN `false` yields the body that names nobody, so a client who waited is never told
   * nobody turned up.
   */
  clientSideEverPresent: boolean | null;
}

/** ONE headline across every cell. The MEETING is the subject; the body carries who. */
const NOT_HELD_HEADLINE = "This one didn't go ahead";

/**
 * §R11 — resolve the not-held panel, or `null` when the meeting was held.
 *
 * ⚠ THE HEADLINE NEVER NAMES WHO WAS ABSENT, and the CHIP never does either. That is what
 * keeps the panel non-scolding in the cell that matters most: an expert reading their own
 * `missed_call` is never told they failed. Client-side absence names the PARTY (no individual
 * is identifiable as "the absentee"); expert-side absence is RETROSPECTIVE and names the
 * person, per CLAUDE.md's attribution rule.
 *
 * ⚠ A `missed_call` NOBODY CLIENT-SIDE ATTENDED EITHER NAMES NOBODY. The outcome only says the
 * delivering expert never joined; when presence shows no client side either, nobody waited and
 * nobody was let down, so both lenses read the same neutral {@link NOBODY_JOINED_NOTE}.
 *
 * ⚠ `venue_unavailable` NAMES NOBODY EITHER, on both lenses — the call room was never ready, so
 * nobody could join, and that is Balo's failure rather than either party's. It is a STORED
 * outcome checked ahead of `missed_call`, so it always wins over the derived `nobody_joined`.
 *
 * ⚠ NO MONEY PROSE HERE. The design reference's "you were not charged. The no-show policy
 * applied." is DELETED, not reworded — Rule M's one line replaces it, and there is no
 * no-show-policy page to link to.
 *
 * ⚠ `cancelled` IS REACHABLE BY URL even though nothing links a recap for it. One arm so it
 * cannot 500.
 */
export function resolveNotHeld(input: NotHeldInput): RecapNotHeldView | null {
  const { status, outcome, lens, expertPersonLabel, clientCompanyName, clientSideEverPresent } =
    input;

  if (status === 'cancelled') {
    return {
      reason: 'cancelled',
      headline: NOT_HELD_HEADLINE,
      body: 'This consultation was cancelled.',
    };
  }

  if (outcome === 'no_show_client') {
    return {
      reason: 'no_show_client',
      headline: NOT_HELD_HEADLINE,
      body:
        lens === 'client'
          ? expertPersonLabel + ' joined and waited.'
          : 'No one from ' + clientCompanyName + ' joined.',
    };
  }

  if (outcome === 'venue_unavailable') {
    // BAL-581 — the call room was never ready: Balo's failure, so the body names nobody on
    // either lens and carries no money prose (the money block states the zero). Checked BEFORE
    // `missed_call` so a STORED `venue_unavailable` always wins over PR #335's `nobody_joined`,
    // which is only ever derived from `missed_call`.
    return {
      reason: 'venue_unavailable',
      headline: NOT_HELD_HEADLINE,
      body: VENUE_UNAVAILABLE_RECAP_BODY,
    };
  }

  if (outcome === 'missed_call') {
    return {
      reason: clientSideEverPresent === false ? 'nobody_joined' : 'missed_call',
      headline: NOT_HELD_HEADLINE,
      body: missedCallBody(lens, expertPersonLabel, clientSideEverPresent),
    };
  }

  return null;
}

/** The `missed_call` body — see {@link resolveNotHeld} for who each cell names. */
function missedCallBody(
  lens: RecapLens,
  expertPersonLabel: string,
  clientSideEverPresent: boolean | null
): string {
  if (clientSideEverPresent === false) {
    return NOBODY_JOINED_NOTE + '.';
  }
  return lens === 'client' ? expertPersonLabel + " wasn't able to join." : "The call didn't start.";
}

/**
 * The single `recap_state` analytics value for this render. SIX values, not three: the
 * artefact-absent reality is the COMMON case today, and burying it inside `processing` would
 * make it unmeasurable on day one.
 *
 * Precedence is deliberate — OUTCOME wins over ARTEFACTS. A cancelled or not-held meeting is
 * that, whatever its (absent) artefacts say.
 */
export function resolveRecapState(input: {
  notHeld: RecapNotHeldView | null;
  artifacts: RecapArtifactsView;
}): RecapState {
  if (input.notHeld !== null) {
    return input.notHeld.reason === 'cancelled' ? 'cancelled' : 'not_held';
  }
  const summaryState = input.artifacts.summary.state;
  if (summaryState === 'failed') return 'artifacts_failed';
  if (summaryState === 'processing') return 'processing';
  if (summaryState === 'ready') return 'ready';
  return 'artifacts_absent';
}
