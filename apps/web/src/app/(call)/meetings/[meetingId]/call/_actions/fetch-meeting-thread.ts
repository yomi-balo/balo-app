'use server';

import 'server-only';

import { z } from 'zod';
import { conversationsRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { callActionErrorFields, enterCallAction } from '@/lib/meetings/call-action-entry';
import { resolveMeetingChatAccess } from '@/lib/meetings/meeting-chat-anchor';
import { mapMessageRowToView } from '@/lib/conversations/conversation-view';
import type { FetchMeetingThreadResult } from '@/lib/meetings/meeting-panels';

const PAGE_SIZE = 30;

const inputSchema = z
  .object({
    meetingId: z.uuid(),
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
 * BAL-437 — the in-call chat panel's thread read. Keyset pagination is strict
 * `(created_at, id) <`, so repeated "Show earlier" calls never duplicate or skip a row.
 *
 * ⚠⚠ THE SCOPE IS `{ kind: 'full' }`, AND THAT IS HALF OF RULING R3. A **member** in the call
 * reads the whole engagement thread — *"a participant opening the panel sees the engagement's
 * thread, not an empty room"*. The `{ kind: 'meeting', meetingId }` narrowing exists for
 * GUESTS and belongs to **BAL-445**; it must not be used here, and
 * `resolveGuestConversationScope` must not gain a second expression to serve this surface.
 *
 * ⚠⚠ GENUINELY READ-ONLY, AND IT MUST STAY THAT WAY. It authenticates with bare
 * `requireUser()` — a pre-onboarding session may legitimately read — and therefore sits on
 * `_read-only-actions.ts`'s `READ_ONLY_ALLOWLIST`. `onboarding-mutation-gate.test.ts` reads
 * THIS FILE'S SOURCE and cannot see a write reached through an import, so the discipline lives
 * here: `resolveMeetingChatAccess` reaches `conversationsRepository.findByContext` — a SELECT.
 * It must NEVER become `ensureForContext` / `ensureManyForContexts`: minting a conversation row
 * from a READ path is exactly the transitive-write defect BAL-424 closed, and it would do it
 * behind a bare `requireUser()`.
 *
 * ⚠ NO WRITABILITY GATE ON THE READ. A closed case's thread stays fully readable; `writable` is
 * REPORTED so the composer can disable itself. Read access and write access are separate
 * questions — the shipped `fetch-case-thread.ts` split, verbatim.
 *
 * ⚠ A MEETING WITH NO ANCHOR NEVER REACHES HERE IN PRODUCTION — the RSC leaves the Chat slot
 * unregistered, so no component can call this. It is still handled, with the same literal as a
 * denial, because a Server Action is a public endpoint and must never assume its own UI.
 */
export async function fetchMeetingThreadAction(
  input: z.infer<typeof inputSchema>
): Promise<FetchMeetingThreadResult> {
  // ⚠ THE THUNK IS DELIBERATE, NOT STYLE: `onboarding-mutation-gate.test.ts` scans this file's
  // own comment-stripped source for a real `requireUser(` call, and this action is on
  // `READ_ONLY_ALLOWLIST` precisely because it makes one. A bare value reference would drop it
  // out of that scan's set and silence the invariant that allowlists it.
  const entry = await enterCallAction(() => requireUser(), inputSchema, input);
  if (!entry.ok) return { success: false, error: entry.error };
  const { user } = entry;
  const { meetingId, before } = entry.data;

  try {
    const access = await resolveMeetingChatAccess({ meetingId, userId: user.id });
    if (!access.ok || access.anchor === null) {
      return { success: false, error: 'This conversation is no longer available.' };
    }

    const page = await conversationsRepository.listMessagesPage({
      conversationId: access.anchor.conversationId,
      // ⚠ STATED, NEVER DEFAULTED. See the docblock — a repository default would put the
      // guest filter one forgotten argument from a disclosure.
      scope: { kind: 'full' },
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
      viewerUserId: user.id,
      // ⚠ `=== true`, NEVER a truthiness check or a `?? true`. `writable` is `boolean | null`
      // and `null` means NOT RESOLVED (the caller opted out) — which must read as read-only, not
      // as open. This action never opts out, so in practice it is always a boolean; the strict
      // comparison is what keeps that true if somebody adds `withWritability: false` here later.
      writable: access.anchor.writable === true,
    };
  } catch (error) {
    log.error('Failed to fetch meeting conversation thread', {
      meetingId,
      userId: user.id,
      ...callActionErrorFields(error),
    });
    return { success: false, error: 'Could not load this conversation. Please try again.' };
  }
}
