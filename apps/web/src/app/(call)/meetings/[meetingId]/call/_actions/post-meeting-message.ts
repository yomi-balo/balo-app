'use server';

import 'server-only';

import { z } from 'zod';
import { conversationsRepository } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { callActionErrorFields, enterCallAction } from '@/lib/meetings/call-action-entry';
import { resolveMeetingChatAccess } from '@/lib/meetings/meeting-chat-anchor';
import { publishConversationEvent } from '@/lib/realtime/ably-server';
import { CONVERSATION_EVENT_MESSAGE } from '@/lib/realtime/channels';
import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
import { plainMessageToHtml } from '@/lib/sanitize/plain-message-html';
import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';
import { MESSAGE_MAX_TEXT } from '@/lib/project-request/conversation-view-types';
import type { ConversationMessageView } from '@/lib/conversations/conversation-view-types';
import type { PostMeetingMessageResult } from '@/lib/meetings/meeting-panels';

const inputSchema = z
  .object({
    meetingId: z.uuid(),
    // 20000 = a coarse server DoS bound on the RAW payload; the UX limit is
    // MESSAGE_MAX_TEXT *plain* characters, enforced below after the strip.
    body: z.string().min(1).max(20000),
  })
  .strict();

/**
 * BAL-437 — post a message from the IN-CALL chat panel into the meeting's engagement thread.
 *
 * ⚠⚠ **THE ONE LINE THAT MAKES THIS DIFFERENT FROM `postCaseMessageAction` IS
 * `sentDuringMeetingId`.** That stamp is the acceptance criterion: the message lands in the
 * durable conversation (so the dashboard case surface shows it) AND is marked as having been
 * said during this call (so the recap and any meeting-scoped read can find it). There is
 * deliberately NO `meeting` value on `conversation_context_type` — one call does not get its
 * own thread, and BAL-424's 1:1 context seam makes "two threads for one case"
 * unrepresentable.
 *
 * ⚠⚠ THE GATE RE-RUNS IN FULL, EVERY CALL. Server Actions bypass middleware, so this must
 * never trust the page's earlier decision. `meeting_contexts.context_id` has no FK and no RLS,
 * so an unchecked `meetingId` from a crafted body would otherwise resolve to another tenant's
 * thread and post into it.
 *
 * ⚠⚠ AND IT ADDITIONALLY REQUIRES `writable`. A CLOSED case stays fully readable by everyone
 * who could read it while it was open, but nobody may post to it — and the SAME thread is
 * rendered by the dashboard case surface, which already refuses on that rule with this exact
 * sentence. Two surfaces, one wording, one predicate.
 *
 * ⚠ SECURITY BOUNDARY, COPIED VERBATIM FROM `post-case-message.ts`: plain text → escaped
 * minimal HTML → sanitiser, BEFORE persist. The STORED body is the sanitised HTML and the Ably
 * payload carries that same string, which is what lets the client re-sanitise defensively
 * without the two ever disagreeing.
 *
 * ⚠⚠ IT PUBLISHES ON THE **CONVERSATION** CHANNEL, NOT THE MEETING ONE. A colleague with the
 * case open in another tab subscribes to `conversation:{id}` and to nothing else; publishing to
 * `meeting:{id}` would leave their thread silently stale, and publishing to both would be two
 * definitions of "a message was posted". See `channels.ts` for the full grain split.
 *
 * ⚠ NO `revalidatePath`. This is a client island inside a LIVE CALL — revalidating would
 * invalidate a dashboard route nobody is looking at and could wipe the composer mid-sentence.
 *
 * ⚠ NO NOTIFICATION EVENT, AS A DECISION. `sent_during_meeting_id` exists precisely to mark a
 * message as call-scoped rather than thread-scoped; fanning it out to absent readers would
 * erase the distinction the column was added to record. ⚠ THE COUNTER-ARGUMENT, RECORDED: a
 * case participant who is NOT in the call gets no notification for a message that IS in their
 * thread. Accepted — notifying somebody about *"dropping it in the Files tab now"* is noise,
 * and the recap plus the thread remain the record. If product disagrees, the hook is the
 * post-commit block below, which already has `post-case-message.ts`'s shape.
 */
export async function postMeetingMessageAction(
  input: z.infer<typeof inputSchema>
): Promise<PostMeetingMessageResult> {
  const entry = await enterCallAction(() => requireOnboardedUser(), inputSchema, input);
  if (!entry.ok) return { success: false, error: entry.error };
  const { user } = entry;
  const { meetingId, body } = entry.data;

  try {
    const access = await resolveMeetingChatAccess({
      meetingId,
      actor: { kind: 'member', userId: user.id },
    });
    if (!access.ok || access.anchor === null) {
      return { success: false, error: 'This conversation is no longer available.' };
    }
    // ⚠ `!== true`, NEVER `!writable`. `writable` is `boolean | null` and `null` means NOT
    // RESOLVED (a caller passed `withWritability: false`, or — structurally, though this
    // action always passes a MEMBER actor and can never reach it — a guest, whose arm never
    // resolves writability at all). BAL-445: this single test is a real, independent closure
    // on guest authorship, on top of `requireOnboardedUser()` above.
    if (access.anchor.writable !== true) {
      return { success: false, error: 'This case is closed, so the conversation is read-only.' };
    }

    const html = sanitizeProjectHtml(plainMessageToHtml(body));
    const plainText = htmlToPlainText(html);
    if (plainText.length === 0) {
      return { success: false, error: 'Type a message first.' };
    }
    if (plainText.length > MESSAGE_MAX_TEXT) {
      return { success: false, error: `Keep your message under ${MESSAGE_MAX_TEXT} characters.` };
    }

    const { conversationId } = access.anchor;
    const row = await conversationsRepository.postMessage({
      conversationId,
      senderUserId: user.id,
      body: html,
      // ⚠⚠ THE STAMP. This single argument is the acceptance criterion — see the docblock.
      sentDuringMeetingId: meetingId,
    });

    const senderName =
      [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || 'Participant';
    const message: ConversationMessageView = {
      id: row.id,
      conversationId,
      bodyHtml: row.body,
      senderUserId: user.id,
      senderName,
      createdAtIso: row.createdAt.toISOString(),
    };

    // Sending = you have read your own thread up to this instant. ⚠ NEVER fail a delivered
    // message over a watermark hiccup — the row is already committed and a retry would
    // double-post.
    try {
      await conversationsRepository.markThreadRead({
        conversationId,
        userId: user.id,
        at: row.createdAt,
      });
    } catch (error) {
      log.warn('Failed to advance read watermark after in-call post', {
        meetingId,
        conversationId,
        userId: user.id,
        error: errorMessage(error),
      });
    }

    void publishConversationEvent(conversationId, CONVERSATION_EVENT_MESSAGE, message);

    // ⚠ THE KEY BUSINESS EVENT. Never the body, never a preview of it.
    log.info('In-call conversation message posted', {
      meetingId,
      conversationId,
      userId: user.id,
      messageId: row.id,
    });

    return { success: true, message };
  } catch (error) {
    log.error('Failed to post in-call conversation message', {
      meetingId,
      userId: user.id,
      ...callActionErrorFields(error),
    });
    return { success: false, error: 'Could not send your message. Please try again.' };
  }
}
