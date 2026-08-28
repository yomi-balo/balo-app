import 'server-only';

import { transcriptArtifactsRepository, transcriptsRepository } from '@balo/db';
import type { GuestAccessScopeLabel } from '@balo/shared/meetings';
import { checkMemoryLimit } from '@/lib/rate-limit/memory-window';
import { log } from '@/lib/logging';
import { durationMinutesOf } from '@/lib/meetings/meeting-duration';
import { resolveGuestRecapAccess } from '@/lib/meetings/resolve-guest-recap-access';
import { guestContextLabel } from '../../_lib/guest-context-label';
import type { GuestRecapSummaryView, GuestRecapView } from './guest-recap-view-types';

/**
 * BAL-439 — the guest recap's loader. Mirrors `list-guest-meeting-files.ts:79-161` step for
 * step: rate-limit on the IP FIRST, resolve the gate, rate-limit again on the resolved guest,
 * discharge lifecycle (the loader's job — the gate deliberately does not), read exactly two
 * artefact projections, compose, log, collapse a throw to the SAME `null` every other denial
 * produces.
 */

/** The two non-`ready` transcript statuses the guest summary card distinguishes. */
type TranscriptStatusLike = 'processing' | 'ready' | 'failed';

/**
 * §5.1 of the plan — deliberately NOT `resolveArtifacts` (the member recap's `_lib/resolve-
 * recap-state.ts`). That function resolves TWO artefacts plus a `collapsed` flag whose whole
 * meaning is "neither the summary nor the transcript has anything to show" — meaningless here,
 * because the guest has no transcript card to coordinate with. Reusing it would also drag a
 * route-private member `_lib` module across route trees, which this codebase names as a defect
 * in as many words (`local-date-time.tsx`: "a route-private `_components/` file imported from
 * another route is a lie about ownership").
 *
 * ⚠ NO `awaitingPipeline` / GRACE-WINDOW ARM, AND THAT IS A DECISION, NOT AN OMISSION. The
 * member recap speculates "the pipeline may still be coming" for 30 minutes after `ended_at`
 * because a member arrives straight from the end-of-call screen. A guest arrives from an
 * emailed invitation, typically days later, and a speculative "still writing this up…" promise
 * to an external reader who may never return is worse than the honest absent copy. Dropping it
 * also keeps this function — and the whole loader — CLOCK-FREE: no `now` injection, deterministic
 * under test, and no shared-constant drift risk against `load-recap.ts`'s module-private
 * `PIPELINE_GRACE_MS`.
 *
 * ⚠ AN EMPTY-STRING ARTEFACT NORMALISES TO `absent`, NEVER a `ready` card with no body — the
 * same rule `RecapArtifactView` states: an empty card reads as a bug.
 */
export function resolveGuestSummary(input: {
  readonly transcriptStatus: TranscriptStatusLike | null;
  readonly summaryContent: string | null;
}): GuestRecapSummaryView {
  if (input.transcriptStatus === 'failed') {
    return { state: 'failed', content: null };
  }
  if (input.transcriptStatus === 'processing') {
    return { state: 'processing', content: null };
  }
  const trimmed = input.summaryContent?.trim() ?? '';
  return trimmed.length === 0
    ? { state: 'absent', content: null }
    : { state: 'ready', content: trimmed };
}

export interface LoadGuestRecapInput {
  readonly rawToken: string;
  readonly meetingId: string;
  /** Pre-hashed by the page, so this module never touches `next/headers` (testability). */
  readonly clientIpHash: string;
}

/**
 * ⚠⚠ R12 (post-plan addendum) — a THIN WRAPPER around {@link GuestRecapView}, ADDED SOLELY so
 * the page can fire `GUEST_SERVER_EVENTS.GUEST_RECAP_VIEWED` without a second gate call.
 * `GuestRecapView` itself is UNCHANGED and stays exactly the four-key structural-concealment
 * shape (§5.2) — `guestId` / `accessScope` never cross into it, never render, and never reach
 * `GuestRecapCard`. They exist on THIS wrapper only, for the page's own `distinct_id` /
 * `access_scope` analytics properties, the same way `resolveGuestRecapAccess`'s own
 * `GuestRecapAccess` already carries them for logging.
 */
export interface GuestRecapLoadResult {
  readonly view: GuestRecapView;
  /** `meeting_guests.id` — for `distinct_id` ONLY. NEVER a `users.id`, never rendered. */
  readonly guestId: string;
  /** The grant AS RECORDED — for the analytics property ONLY. NEVER rendered. */
  readonly accessScope: GuestAccessScopeLabel;
}

/**
 * Load the guest recap, or `null`.
 *
 * ⚠ ONE `null` FOR EVERY DENIAL — throttled, unresolvable token, gate refusal, not-yet-`ended`
 * meeting, and a repository throw all collapse into it. The page answers one `LinkNotActive`
 * card with one shape.
 */
export async function loadGuestRecap(
  input: LoadGuestRecapInput
): Promise<GuestRecapLoadResult | null> {
  // ⚠⚠ FIRST, BEFORE ANY HASHING OR DB READ — `resolve-meeting-guest.ts` states this obligation
  // in as many words and calls it non-optional.
  if (!checkMemoryLimit(`guest-recap:ip:${input.clientIpHash}`)) {
    return null;
  }

  try {
    const access = await resolveGuestRecapAccess(input.rawToken, input.meetingId);
    if (access === null) {
      return null;
    }

    // ⚠⚠ DISJOINT `:ip:` / `:gid:` PREFIXES, AND A HASHED IP SEGMENT — BAL-445's S1 fix
    // (`list-guest-meeting-files.ts`): a bare prefix let `X-Forwarded-For: id:<victim>` collide
    // with a victim's own bucket. Both halves are load-bearing here too.
    if (!checkMemoryLimit(`guest-recap:gid:${access.guestId}`)) {
      return null;
    }

    // ⚠ `'ended'` ONLY — not `'cancelled'`. The member recap's `cancelled` arm renders
    // `NotHeldPanel`, whose copy NAMES WHO WAS ABSENT — counterparty information R4 closes. So:
    // ended, or nothing. This is the loader's job; the gate deliberately does not discharge it.
    if (access.meeting.status !== 'ended') {
      return null;
    }

    const transcript = await transcriptsRepository.findByMeetingId(access.meeting.id);
    // ⚠ `'summary'` ONLY. The literal `'cleaned'` must never appear in this tree — the
    // transcript closure (R6), pinned by `guest-recap-closed-surfaces.test.ts`.
    //
    // ⚠⚠ fix-round-1 / S3 — GUARDED ON `status === 'ready'`. `findByTranscriptAndKind` is a
    // bare `select()` returning the WHOLE artifact row, and `resolveGuestSummary` discards
    // `summaryContent` unconditionally for `processing` / `failed` (the status alone decides
    // the card). Reading a potentially large `content` column just to throw it away is pure
    // waste for exactly those two states — skip the read entirely rather than fetch-then-drop.
    const summaryRow =
      transcript === undefined || transcript.status !== 'ready'
        ? undefined
        : await transcriptArtifactsRepository.findByTranscriptAndKind(transcript.id, 'summary');

    const view: GuestRecapView = {
      // ⚠⚠ fix-round-1 / MUST-5 (security F4) — THE GATE'S ROW, NEVER THE PARSED INPUT. Both
      // shipped guest actions state this rule verbatim, kept uniform so it stays greppable
      // across every read path. `z.uuid()` accepts mixed case and Postgres matches
      // canonically, so `input.meetingId` and `access.meeting.id` can disagree in case for the
      // SAME row — using the parsed input here would fail-closed a meeting-scope guest opening
      // their own recap with an uppercase-cased UUID.
      meetingId: access.meeting.id,
      header: {
        contextLabel: guestContextLabel(access.subject.contextType),
        occurredAtIso: (access.meeting.startedAt ?? access.meeting.scheduledStart).toISOString(),
        durationMinutes: durationMinutesOf(access.meeting),
      },
      summary: resolveGuestSummary({
        transcriptStatus: transcript?.status ?? null,
        // ⚠ `.content` ONLY — `findByTranscriptAndKind` returns the whole artifact row.
        summaryContent: summaryRow?.content ?? null,
      }),
      isOwnMeeting: access.isOwnMeeting,
    };

    log.info('Guest recap opened', {
      guestId: access.guestId,
      meetingId: input.meetingId,
      accessScope: access.accessScope,
      isOwnMeeting: access.isOwnMeeting,
    });

    return { view, guestId: access.guestId, accessScope: access.accessScope };
  } catch (error) {
    // ⚠ NO `guestId` HERE — `access` is scoped inside the `try`, same as the shipped guest
    // actions: a throw from `resolveGuestRecapAccess` itself means there is no resolved guest
    // to name.
    log.error('Failed to load guest recap', {
      meetingId: input.meetingId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}
