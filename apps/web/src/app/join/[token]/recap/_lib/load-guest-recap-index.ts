import 'server-only';

import { meetingContextsRepository } from '@balo/db';
import { conversationSubjectForMeetingContext } from '@balo/shared/conversations';
import { guestIsAdmittedForRead } from '@balo/shared/meetings';
import { checkMemoryLimit } from '@/lib/rate-limit/memory-window';
import { log } from '@/lib/logging';
import { durationMinutesOf } from '@/lib/meetings/meeting-duration';
import { guestRecapPath } from '@/lib/meetings/join-link';
import { resolveMeetingGuestSubject } from '@/lib/meetings/resolve-meeting-guest';
import {
  resolveGuestRecapAccess,
  type GuestRecapAccess,
} from '@/lib/meetings/resolve-guest-recap-access';
import { guestContextLabel } from '../../_lib/guest-context-label';
import { meetingContextTypesForEnvelope } from './envelope-context-types';
import type { GuestRecapIndexRowView } from './guest-recap-index-view-types';

/**
 * BAL-492 — a hard structural brake on the per-row re-gate's N+1 cost (~4 round trips per
 * candidate, see `resolve-guest-recap-access.ts`'s composition). `.slice(-MAX_INDEX_CANDIDATES)`
 * takes the tail of the repository's own `scheduled_start ASC, id ASC` order — the most recent
 * candidates by SCHEDULED start, deliberately NOT re-sorted on `startedAt ?? scheduledStart`
 * first (that would be a second reading of a meeting's timestamp ahead of the gate's own
 * projection, which D1 reserves to the verdict alone). No "showing 24 of N" affordance — that
 * would disclose envelope size, which PR #243 already refused to ship.
 */
const MAX_INDEX_CANDIDATES = 24;

/**
 * BAL-492 — the per-row gate fan-out's concurrency ceiling. `packages/db/src/client.ts`
 * leaves postgres-js's pool `max` at its default of 10; each `resolveGuestRecapAccess` call costs
 * ~4-6 sequential reads, so an unchunked `Promise.all` over up to `MAX_INDEX_CANDIDATES` candidates
 * can queue 100-140 queries from ONE index render and starve authenticated requests sharing the
 * same pool. Below the pool's own ceiling so this loader is never the sole occupant of the pool.
 */
const GATE_CONCURRENCY = 5;

type MeetingContextCandidate = Awaited<
  ReturnType<typeof meetingContextsRepository.listMeetingsForContexts>
>[number];

/**
 * BAL-492 — de-duplicates the reverse read's candidates by `meeting.id`, keeping only `ended`
 * meetings, in the repository's own `scheduled_start ASC, id ASC` order.
 */
export function dedupedEndedMeetingIds(candidates: readonly MeetingContextCandidate[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const candidate of candidates) {
    if (candidate.meeting.status !== 'ended') {
      continue;
    }
    if (seen.has(candidate.meeting.id)) {
      continue;
    }
    seen.add(candidate.meeting.id);
    ids.push(candidate.meeting.id);
  }
  return ids;
}

/**
 * BAL-492 — gate `ids` through {@link resolveGuestRecapAccess}
 * `GATE_CONCURRENCY`-at-a-time instead of one flat `Promise.all`. Chunks run sequentially; calls
 * WITHIN a chunk run concurrently. The result array preserves `ids`' order, so callers that rely
 * on positional correspondence (e.g. the cap's "last 24" test) see no change from the flat form.
 */
async function gateCandidatesInChunks(
  rawToken: string,
  ids: readonly string[]
): Promise<ReadonlyArray<GuestRecapAccess | null>> {
  const verdicts: Array<GuestRecapAccess | null> = [];
  for (let start = 0; start < ids.length; start += GATE_CONCURRENCY) {
    const chunk = ids.slice(start, start + GATE_CONCURRENCY);
    const chunkVerdicts = await Promise.all(
      chunk.map((id) => resolveGuestRecapAccess(rawToken, id))
    );
    verdicts.push(...chunkVerdicts);
  }
  return verdicts;
}

/**
 * BAL-492 — the guest recap INDEX's discriminated result.
 *
 * ⚠⚠ A DISCRIMINATED RESULT, NOT A PLAIN NULLABLE VIEW — because of D2. Next implements
 * `redirect()` by throwing `NEXT_REDIRECT`, and this loader's house pattern (mirroring
 * `load-guest-recap.ts:163-173`) is `try { … } catch { return null }`, which would SWALLOW that
 * throw silently and render `LinkNotActive` instead of redirecting. So this loader RETURNS the
 * redirect target and the PAGE throws it, outside any `try`.
 */
export type GuestRecapIndexResult =
  | { readonly kind: 'redirect'; readonly href: string }
  | {
      readonly kind: 'index';
      readonly rows: readonly GuestRecapIndexRowView[];
      /** `meeting_guests.id` — for `distinct_id` ONLY. NEVER a `users.id`, never rendered. */
      readonly guestId: string;
    };

export interface LoadGuestRecapIndexInput {
  readonly rawToken: string;
  /** Pre-hashed by the page, so this module never touches `next/headers` (testability). */
  readonly clientIpHash: string;
}

/** Total ordering on rows: `occurredAtIso` DESCENDING, `meetingId` ASCENDING as the tie-break.
 *  ⚠ ISO strings compare correctly lexicographically — never parse back to `Date`. */
function compareRowsMostRecentFirst(a: GuestRecapIndexRowView, b: GuestRecapIndexRowView): number {
  if (a.occurredAtIso !== b.occurredAtIso) {
    return a.occurredAtIso > b.occurredAtIso ? -1 : 1;
  }
  if (a.meetingId === b.meetingId) {
    return 0;
  }
  return a.meetingId < b.meetingId ? -1 : 1;
}

/** Project the three disclosed primitives from the GATE'S OWN verdict — never from the reverse
 *  read's row. This is the D1 rule, stated as code: the reverse read is a candidate generator
 *  with no authorization or projection authority whatsoever. */
function projectRow(access: GuestRecapAccess): GuestRecapIndexRowView {
  return {
    meetingId: access.meeting.id,
    contextLabel: guestContextLabel(access.subject.contextType),
    occurredAtIso: (access.meeting.startedAt ?? access.meeting.scheduledStart).toISOString(),
    durationMinutes: durationMinutesOf(access.meeting),
  };
}

/**
 * Load the token-reached guest recap INDEX, or `null`.
 *
 * ⚠ ONE `null` FOR EVERY DENIAL — throttled, unresolvable token, pending admission, a declined
 * request-grain relationship, and a repository throw all collapse into it, exactly like
 * `loadGuestRecap`. The page answers one `LinkNotActive` card with one shape.
 *
 * ⚠⚠ THE REVERSE READ (`meetingContextsRepository.listMeetingsForContexts`) IS A CANDIDATE
 * GENERATOR WITH ZERO AUTHORIZATION AUTHORITY. Every survivor is re-checked through
 * {@link resolveGuestRecapAccess} — the SAME per-meeting gate `/join/[token]/recap/[meetingId]`
 * itself runs. This loader never calls `loadGuestRecap` in the per-row loop: that function
 * spends TWO rate-limit tokens per call against a 30/60s budget, which would throttle the index
 * against itself over anything but a tiny envelope.
 */
export async function loadGuestRecapIndex(
  input: LoadGuestRecapIndexInput
): Promise<GuestRecapIndexResult | null> {
  // ⚠⚠ FIRST, BEFORE ANY HASHING OR DB READ — `resolve-meeting-guest.ts` states this
  // obligation in as many words and calls it non-optional.
  if (!checkMemoryLimit(`guest-recap-index:ip:${input.clientIpHash}`)) {
    return null;
  }

  try {
    const subject = await resolveMeetingGuestSubject(input.rawToken);
    if (subject === null) {
      return null;
    }

    // ⚠⚠ DISJOINT `:ip:` / `:gid:` PREFIXES FROM THE PER-MEETING RECAP'S `guest-recap:ip:` /
    // `guest-recap:gid:` — BAL-445's S1 fix restated on this surface, so a scanner storm
    // against one route cannot exhaust the other's budget.
    if (!checkMemoryLimit(`guest-recap-index:gid:${subject.guest.id}`)) {
      return null;
    }

    // ⚠⚠ D2 — a `meeting`-scope guest holds a SINGLETON grant, so there is no index to build.
    // Redirect them to their own anchor recap. NOT gated on `ended` — the per-meeting page is
    // already the single authority for that check. `resolveGuestRecapAccess` and
    // `listMeetingsForContexts` are BOTH called ZERO times on this arm.
    //
    // ⚠⚠ THE REDIRECT IS GATED ON ADMISSION, via the SAME predicate
    // `authorizeMeetingFileAccess`'s guest arm uses (`guestIsAdmittedForRead`). Without this, a
    // live-but-`pending` guest got an HTTP 307 instead of the uniform `LinkNotActive` every other
    // denial collapses to — a distinct outcome for one denial cause, breaking the property that
    // ALL denials render one shape.
    if (subject.guest.accessScope === 'meeting') {
      if (!guestIsAdmittedForRead(subject.admission)) {
        return null;
      }
      log.info('Guest recap index redirected to anchor', { guestId: subject.guest.id });
      return { kind: 'redirect', href: guestRecapPath(input.rawToken, subject.meeting.id) };
    }

    const anchor = await resolveGuestRecapAccess(input.rawToken, subject.meeting.id);
    if (anchor === null) {
      return null;
    }

    const envelope = conversationSubjectForMeetingContext(anchor.subject);
    if (envelope === null) {
      // `project_discovery` — no single conversation is implied, so the guest's envelope is
      // structurally empty. Authorised, not a denial: an honest empty index.
      log.info('Guest recap index opened', {
        guestId: anchor.guestId,
        accessScope: anchor.accessScope,
        meetingCount: 0,
        candidateCount: 0,
      });
      return { kind: 'index', rows: [], guestId: anchor.guestId };
    }

    const contexts = meetingContextTypesForEnvelope(envelope);
    const candidates = await meetingContextsRepository.listMeetingsForContexts(contexts);

    const dedupedEndedIds = dedupedEndedMeetingIds(candidates);

    // ⚠ THE CAP. `.slice(-N)` on the repository's own `scheduled_start ASC` order — the tail is
    // the most recent N by SCHEDULED start. No new date derivation; see the constant's docblock.
    const gatedIds = dedupedEndedIds.slice(-MAX_INDEX_CANDIDATES);

    // ⚠⚠ THE ANCHOR IS REUSED for its own id rather than re-gated. When the
    // guest's own (already-verdicted) meeting is `ended` and reappears in the envelope's
    // candidates, gating it again would cost a second full `resolveGuestRecapAccess` (~4 round
    // trips) for a verdict this function already holds.
    const anchorMeetingId = anchor.meeting.id;
    const idsNeedingGate = gatedIds.filter((id) => id !== anchorMeetingId);

    // ⚠⚠ THE AUTHORISATION. Only an `ok` verdict becomes a row — the reverse read never does.
    // Chunked, not one flat `Promise.all`; see `gateCandidatesInChunks`'s docblock.
    const gatedVerdicts = await gateCandidatesInChunks(input.rawToken, idsNeedingGate);
    const verdicts: ReadonlyArray<GuestRecapAccess | null> = gatedIds.includes(anchorMeetingId)
      ? [...gatedVerdicts, anchor]
      : gatedVerdicts;

    const rows = verdicts
      .filter((verdict): verdict is GuestRecapAccess => verdict !== null)
      .map(projectRow)
      .sort(compareRowsMostRecentFirst);

    log.info('Guest recap index opened', {
      guestId: anchor.guestId,
      accessScope: anchor.accessScope,
      meetingCount: rows.length,
      candidateCount: gatedIds.length,
    });

    return { kind: 'index', rows, guestId: anchor.guestId };
  } catch (error) {
    // ⚠ NO `guestId` HERE — `subject`/`anchor` are scoped inside the `try`, same as
    // `load-guest-recap.ts`: a throw before either resolved means there is no id to name.
    log.error('Failed to load guest recap index', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}
