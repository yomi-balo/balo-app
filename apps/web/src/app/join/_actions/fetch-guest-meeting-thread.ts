'use server';

import 'server-only';

import { z } from 'zod';
import { headers } from 'next/headers';
import { conversationsRepository } from '@balo/db';
import { checkMemoryLimit } from '@/lib/rate-limit/memory-window';
import { hashedClientIp } from '@/lib/magic-link';
import { log } from '@/lib/logging';
import { resolveMeetingGuestSubject } from '@/lib/meetings/resolve-meeting-guest';
import { resolveMeetingChatAccess } from '@/lib/meetings/meeting-chat-anchor';
import { GUEST_READ_UNAVAILABLE_ERROR } from '@/lib/meetings/lobby';
import { mapMessageRowToView } from '@/lib/conversations/conversation-view';
import type { FetchGuestMeetingThreadResult } from '@/lib/meetings/meeting-panels';

const PAGE_SIZE = 30;

const inputSchema = z
  .object({
    meetingId: z.uuid(),
    guestToken: z.string().min(20).max(200),
    /** Exclusive keyset cursor — the OLDEST already-loaded message. */
    before: z
      .object({
        createdAtIso: z.iso.datetime(),
        id: z.uuid(),
      })
      .optional(),
  })
  .strict();

/**
 * BAL-445 — the GUEST read of the in-call thread. The conversation-grain sibling of
 * `fetchMeetingThreadAction`, for a token-authenticated guest rather than a signed-in member.
 *
 * ⚠⚠ `scope: access.scope` — STATED, NEVER DEFAULTED, and never `{ kind: 'meeting', … }`
 * written inline here. The narrowing is whatever `resolveGuestConversationScope` (called
 * inside `resolveMeetingChatAccess`'s guest arm) actually returned. Writing the object literal
 * here would be a second expression of the rule and would silently ignore an
 * `engagement`-scoped guest's wider grant.
 *
 * ⚠ THERE IS NO `viewerUserId` AND NO `writable` ON THE RESULT — a guest has no `users.id` (own
 * vs. other bubble alignment is unanswerable) and there is no composer to report writability to.
 *
 * ⚠⚠ F7 (fix-round-1) — a SECOND rate limit, keyed on the RESOLVED `guest.id`, runs after
 * `resolveMeetingGuestSubject`. See `list-guest-meeting-files.ts`'s docblock for the full
 * reasoning: the IP-keyed limiter above is spoofable and this surface is now a DB read
 * amplifier, so a stable, non-spoofable, revocable second key is added rather than relying on
 * the IP key alone.
 *
 * ⚠⚠ S1 (fix-round-2) — the two limiter keys use disjoint `:ip:` / `:gid:` prefixes and the IP
 * segment is hashed via `hashedClientIp` — see `list-guest-meeting-files.ts`'s docblock for the
 * collision this closes.
 *
 * ⚠⚠ F8/WARNING-1 (fix-round-1) — `resolveMeetingGuestSubject` (a DB read) now runs INSIDE the
 * `try`, so a repository throw is logged and collapsed like every other failure shape.
 */
export async function fetchGuestMeetingThreadAction(
  input: z.infer<typeof inputSchema>
): Promise<FetchGuestMeetingThreadResult> {
  if (!checkMemoryLimit(`guest-thread:ip:${hashedClientIp(await headers())}`)) {
    return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
  }
  const { meetingId, guestToken, before } = parsed.data;

  try {
    const subject = await resolveMeetingGuestSubject(guestToken);
    if (subject === null) {
      return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
    }

    // ⚠⚠ S1 (fix-round-2) — `:gid:`, disjoint from the IP key's `:ip:` prefix above.
    if (!checkMemoryLimit(`guest-thread:gid:${subject.guest.id}`)) {
      return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
    }

    const access = await resolveMeetingChatAccess({
      meetingId,
      actor: { kind: 'guest', guest: subject },
    });
    if (!access.ok || access.anchor === null) {
      return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
    }
    // ⚠ Narrowed to the guest arm — `access.scope` only exists there. Unreachable any other
    // way given the `actor: { kind: 'guest' }` passed above, but the gate's static return type
    // still carries the member arm too (see `resolveMeetingChatAccess`'s own module docblock).
    if (access.viewer !== 'guest') {
      return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
    }

    const page = await conversationsRepository.listMessagesPage({
      conversationId: access.anchor.conversationId,
      scope: access.scope,
      before:
        before === undefined
          ? undefined
          : { createdAt: new Date(before.createdAtIso), id: before.id },
      limit: PAGE_SIZE,
    });

    return {
      success: true,
      messages: page.messages.map(mapMessageRowToView),
      hasEarlier: page.hasEarlier,
    };
  } catch (error) {
    // ⚠ NO `guestId` HERE — `subject` is scoped to the `try` (F8/WARNING-1), and a throw from
    // `resolveMeetingGuestSubject` itself means there IS no resolved guest to name.
    log.error('Failed to fetch guest meeting conversation thread', {
      meetingId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GUEST_READ_UNAVAILABLE_ERROR };
  }
}
