'use server';

import 'server-only';

import { z } from 'zod';
import { conversationsRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { publishConversationEvent } from '@/lib/realtime/ably-server';
import { CONVERSATION_EVENT_MESSAGE } from '@/lib/realtime/channels';
import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
import { plainMessageToHtml } from '@/lib/sanitize/plain-message-html';
import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';
import { resolveConversationAccess } from '@/lib/project-request/resolve-conversation-access';
import {
  MESSAGE_MAX_TEXT,
  previewOfPlainText,
  type ConversationMessageView,
} from '@/lib/project-request/conversation-view-types';

const inputSchema = z.object({
  requestId: z.uuid(),
  relationshipId: z.uuid(),
  // 20000 = coarse server DoS bound on the raw text payload; the UX limit is
  // MESSAGE_MAX_TEXT plain chars, enforced below after strip.
  body: z.string().min(1).max(20000),
});

export type PostConversationMessageResult =
  | { success: true; message: ConversationMessageView }
  | { success: false; error: string };

/**
 * Post a conversation message (BAL-271 / A4).
 *
 * THE ONLY `conversation_messages` insert path on the platform — strictly
 * user-triggered (BAL-212: nothing auto-posts). IDOR-safe via
 * `resolveConversationAccess` (the relationshipId is a CLAIM, validated against
 * the server-loaded graph + lens). The composer's plain text is converted to
 * minimal HTML and sanitised BEFORE persist (D4).
 *
 * `postMessage` is called STANDALONE (not inside a wider transaction), so its
 * bare-insert docblock contract is satisfied without SAVEPOINTs.
 *
 * Deliberately NO `revalidatePath`: chat state is island-local + realtime — a
 * full-page revalidate would wipe composer/tab state mid-conversation.
 */
export async function postConversationMessageAction(
  input: z.infer<typeof inputSchema>
): Promise<PostConversationMessageResult> {
  let user;
  try {
    user = await requireUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { requestId, relationshipId, body } = parsed.data;

  try {
    const access = await resolveConversationAccess(user, requestId, relationshipId);
    if (!access.ok) {
      return { success: false, error: access.error };
    }

    // SECURITY BOUNDARY: plain text → escaped minimal HTML → sanitiser, before persist.
    const html = sanitizeProjectHtml(plainMessageToHtml(body));
    const plainText = htmlToPlainText(html);
    if (plainText.length === 0) {
      return { success: false, error: 'Type a message first.' };
    }
    if (plainText.length > MESSAGE_MAX_TEXT) {
      return {
        success: false,
        error: `Keep your message under ${MESSAGE_MAX_TEXT} characters.`,
      };
    }

    const row = await conversationsRepository.postMessage({
      relationshipId,
      senderUserId: user.id,
      body: html,
    });

    const senderName =
      [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || 'Participant';
    const messageView: ConversationMessageView = {
      id: row.id,
      relationshipId,
      bodyHtml: row.body,
      senderUserId: user.id,
      senderName,
      createdAtIso: row.createdAt.toISOString(),
    };

    // Sending = you've read your own thread up to this instant. Never fail the
    // posted message over a watermark hiccup.
    try {
      await conversationsRepository.markThreadRead({
        relationshipId,
        userId: user.id,
        at: row.createdAt,
      });
    } catch (error) {
      log.warn('Failed to advance read watermark after post', {
        requestId,
        relationshipId,
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // BAL-279: both publishes are deferred to Next's `after()` inside their
    // publishers — they run after the response flushes but before the function can
    // freeze, so neither the ephemeral realtime ping nor the durable notification
    // is cut short, and neither adds latency to this action. Both never throw.
    void publishConversationEvent(relationshipId, CONVERSATION_EVENT_MESSAGE, messageView);

    publishNotificationEvent('project.message_posted', {
      correlationId: row.id,
      projectRequestId: requestId,
      relationshipId,
      title: access.request.title,
      senderName,
      recipientRole: access.recipient.role,
      recipientId: access.recipient.role === 'client' ? access.recipient.userId : undefined,
      expertProfileId:
        access.recipient.role === 'expert' ? access.recipient.expertProfileId : undefined,
      preview: previewOfPlainText(plainText),
    }).catch(() => {
      // publishNotificationEvent logs internally.
    });

    log.info('Conversation message posted', {
      requestId,
      relationshipId,
      userId: user.id,
      messageId: row.id,
    });

    return { success: true, message: messageView };
  } catch (error) {
    log.error('Failed to post conversation message', {
      requestId,
      relationshipId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not send your message. Please try again.' };
  }
}
