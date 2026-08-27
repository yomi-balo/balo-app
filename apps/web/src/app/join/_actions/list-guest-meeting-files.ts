'use server';

import 'server-only';

import { z } from 'zod';
import { headers } from 'next/headers';
import { isTwoSidedParty, meetingFilesRepository, MEETING_FILE_LIST_LIMIT } from '@balo/db';
import { checkMemoryLimit } from '@/lib/rate-limit/memory-window';
import { hashedClientIp } from '@/lib/magic-link';
import { log } from '@/lib/logging';
import { resolveMeetingGuestSubject } from '@/lib/meetings/resolve-meeting-guest';
import { authorizeMeetingFileAccess } from '@/lib/meetings/authorize-meeting-file-access';
import { GUEST_READ_UNAVAILABLE_ERROR } from '@/lib/meetings/lobby';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
import type { ListMeetingFilesActionResult } from '@/lib/meetings/meeting-panels';

const inputSchema = z
  .object({
    meetingId: z.uuid(),
    guestToken: z.string().min(20).max(200),
  })
  .strict();

/**
 * BAL-445 — the GUEST read of a meeting's files. Read-only, token-authenticated, no `users.id`.
 *
 * ── ORDER, EVERY STEP LOAD-BEARING (§5, mirrors `/join/[token]/page.tsx`) ──────────────────
 *
 *   1. Rate-limit FIRST, before any hashing or DB read — a distinct key prefix
 *      (`guest-files`) so one surface's storm cannot starve another.
 *   2. `resolveMeetingGuestSubject` — the BAL-445 per-request resolver, an AUTH HELPER (never
 *      `requireUser`), fails closed with ONE `null` indistinguishable from a stranger.
 *   2b. ⚠⚠ F7 (fix-round-1) — A SECOND rate limit, keyed on the RESOLVED `guest.id`, after
 *       resolution. The IP-keyed limiter above trusts `X-Forwarded-For` and is documented as
 *       spoofable — acceptable when it guarded one landing-page render behind a ≥256-bit token,
 *       but this surface is now a DB read amplifier. `guest.id` is stable, non-spoofable and
 *       revocable, so it bounds a real token-holder's extraction rate even if the IP key is
 *       rotated. The IP check still runs FIRST (unauthenticated cost stays cheapest-first).
 *   2c. ⚠⚠ S1 (fix-round-2) — the two limiter keys use DISJOINT `:ip:` / `:gid:` prefixes (one
 *       is never a leading substring of the other) AND the IP segment is hashed via
 *       `hashedClientIp` (see `@/lib/magic-link`'s docblock). Round 1 built the IP key as
 *       `guest-files:${clientIp}` — a bare prefix of `guest-files:id:${guestId}` — so
 *       `X-Forwarded-For: id:<victimGuestId>` produced the byte-identical victim key and let any
 *       member who can read a guest's roster id burn that guest's bucket. Both the disjoint
 *       prefixes and the hash are load-bearing: the hash means the IP segment can never contain
 *       `:` at all, so even a future prefix rename cannot reopen the collision.
 *   3. `authorizeMeetingFileAccess({ actor: { kind: 'guest', … } })` — the shipped gate, guest
 *      arm, which calls `guestMayReadMeeting` (never re-derives the scope rule here).
 *   4. The read: `meetingFilesRepository.listByMeeting`, the SAME `isTwoSidedParty` drop and
 *      `MEETING_FILE_LIST_LIMIT` bound `list-meeting-files.ts` uses — one list, two callers.
 *
 * ⚠ `r2Key` is never projected — same rule as the member action. `uploadedByUserId` IS
 * projected (an opaque UUID; the guest panel resolves no name from it — ADR-1044's
 * concealment rule is about addresses, never ids).
 *
 * ⚠ ONE COLLAPSED FAILURE LITERAL for everything — bad shape, throttled, unresolvable token,
 * out-of-scope meeting, repository throw. This surface must not become an oracle a member
 * surface is not. The SHAPE goes to the log only.
 *
 * ⚠ NEVER ADD TO `PUBLIC_ACTION_ALLOWLIST` — this action authenticates via
 * `resolveMeetingGuestSubject`, which is on `AUTH_HELPERS`. It is neither read-only-allowlisted
 * nor public: it satisfies neither invariant because it needs neither.
 *
 * ⚠⚠ F8/WARNING-1 (fix-round-1) — `resolveMeetingGuestSubject` (a DB read) now runs INSIDE the
 * `try`, so a repository throw is logged and collapsed like every other failure shape, instead
 * of escaping the action with no `log.error` and rejecting the client promise.
 */
export async function listGuestMeetingFilesAction(
  input: z.infer<typeof inputSchema>
): Promise<ListMeetingFilesActionResult> {
  if (!checkMemoryLimit(`guest-files:ip:${hashedClientIp(await headers())}`)) {
    return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
  }
  const { meetingId, guestToken } = parsed.data;

  try {
    const subject = await resolveMeetingGuestSubject(guestToken);
    if (subject === null) {
      return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
    }

    // ⚠⚠ F7 (fix-round-1) — the SECOND limiter, keyed on the resolved guest, not the IP.
    // ⚠⚠ S1 (fix-round-2) — `:gid:`, disjoint from the IP key's `:ip:` prefix above.
    if (!checkMemoryLimit(`guest-files:gid:${subject.guest.id}`)) {
      return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
    }

    const access = await authorizeMeetingFileAccess({
      meetingId,
      actor: { kind: 'guest', guest: subject },
    });
    if (!access.ok) {
      return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
    }

    // ⚠⚠ F8/Uniformity (fix-round-1) — `access.meeting.id`, THE GATE'S ROW, never the parsed
    // input, matching the sibling download action's own rule (`get-guest-meeting-file-
    // download.ts`). Provably equal to `meetingId` today; kept uniform so the rule stays
    // greppable across both read paths.
    const rows = await meetingFilesRepository.listByMeeting(access.meeting.id);

    if (rows.length >= MEETING_FILE_LIST_LIMIT) {
      log.warn('Guest meeting file list hit its bound — newest files were truncated', {
        meetingId,
        guestId: subject.guest.id,
        limit: MEETING_FILE_LIST_LIMIT,
      });
    }

    const files: MeetingFileView[] = [];
    for (const row of rows) {
      // ⚠ SAME RULE AS THE MEMBER LIST — a corrupt `party` is dropped, never coerced.
      if (!isTwoSidedParty(row.party)) {
        log.warn('Dropping meeting file with a non-two-sided party (guest read)', {
          meetingId,
          guestId: subject.guest.id,
          fileId: row.id,
          party: row.party,
        });
        continue;
      }
      files.push({
        id: row.id,
        meetingId: row.meetingId,
        fileName: row.fileName,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
        party: row.party,
        source: row.source,
        uploadedByUserId: row.uploadedByUserId,
        createdAtIso: row.createdAt.toISOString(),
      });
    }

    return { success: true, files };
  } catch (error) {
    // ⚠ NO `guestId` HERE — `subject` is scoped to the `try` (F8/WARNING-1), and a throw from
    // `resolveMeetingGuestSubject` itself means there IS no resolved guest to name.
    log.error('Failed to list guest meeting files', {
      meetingId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
  }
}
