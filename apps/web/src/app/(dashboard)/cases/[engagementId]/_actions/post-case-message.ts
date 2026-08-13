'use server';

import 'server-only';

import { z } from 'zod';
import { caseEngagementsRepository, conversationsRepository } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { publishConversationEvent } from '@/lib/realtime/ably-server';
import { CONVERSATION_EVENT_MESSAGE } from '@/lib/realtime/channels';
import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
import { plainMessageToHtml } from '@/lib/sanitize/plain-message-html';
import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';
import { resolveCaseAccess } from '@/lib/cases/resolve-case-access';
import {
  MESSAGE_MAX_TEXT,
  previewOfPlainText,
} from '@/lib/project-request/conversation-view-types';
import type { ConversationMessageView } from '@/lib/conversations/conversation-view-types';
import {
  publishCaseMessagePosted,
  resolveCaseNotifyContext,
} from '../_lib/case-conversation-notify';
import type { PostCaseMessageResult } from './_types/case-action-types';

const inputSchema = z
  .object({
    engagementId: z.uuid(),
    // 20000 = a coarse server DoS bound on the RAW payload; the UX limit is
    // MESSAGE_MAX_TEXT *plain* characters, enforced below after the strip.
    body: z.string().min(1).max(20000),
  })
  .strict();

/**
 * BAL-421 — post a message into a CASE's conversation.
 *
 * ⚠ THE PROJECT-REQUEST ACTION CANNOT BE REUSED. Every existing conversation action takes
 * `{ requestId, relationshipId }` and resolves access through the request graph; a case has
 * NEITHER. This is the engagement-anchored parallel, gated by `resolveCaseAccess`.
 *
 * ⚠⚠ THE GATE IS RE-RUN IN FULL, EVERY CALL. Server Actions bypass middleware, so this must
 * never trust the page's earlier decision. `conversation_contexts.context_id` has no FK and no
 * RLS, so an unchecked `engagementId` from a crafted request body would resolve to another
 * tenant's thread and post into it.
 *
 * ⚠⚠ AND IT ADDITIONALLY REQUIRES `conversationWritable`. Read access and WRITE access are
 * separate questions: a CLOSED case stays fully readable by everyone who could read it while
 * it was open, but nobody may post to it. That predicate is
 * `engagementConversationIsWritable(engagementStatus)`, composed ONCE at the gate — never
 * re-derived here, so the composer's enabled state and this refusal cannot disagree.
 *
 * ⚠ SECURITY BOUNDARY: plain text → escaped minimal HTML → sanitiser, BEFORE persist. The
 * stored body is the sanitised HTML, and the realtime payload carries that same string.
 *
 * ⚠ NO `revalidatePath`. Chat state is island-local + realtime; a full-page revalidate would
 * wipe the composer mid-conversation.
 */
export async function postCaseMessageAction(
  input: z.infer<typeof inputSchema>
): Promise<PostCaseMessageResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { engagementId, body } = parsed.data;

  try {
    const access = await resolveCaseAccess(engagementId, user.id);
    if (access === null) {
      return { success: false, error: 'This case is no longer available.' };
    }
    if (!access.conversationWritable) {
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

    const { conversationId } = access;
    const row = await conversationsRepository.postMessage({
      conversationId,
      senderUserId: user.id,
      body: html,
      // ⚠ NO `sentDuringMeetingId`. This composer is the CASE SURFACE, never the in-call
      // panel (BAL-132 owns that seam).
    });

    const senderName =
      [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || 'Participant';
    const messageView: ConversationMessageView = {
      id: row.id,
      conversationId,
      bodyHtml: row.body,
      senderUserId: user.id,
      senderName,
      createdAtIso: row.createdAt.toISOString(),
    };

    // Sending = you have read your own thread up to this instant. Never fail the posted
    // message over a watermark hiccup.
    try {
      await conversationsRepository.markThreadRead({
        conversationId,
        userId: user.id,
        at: row.createdAt,
      });
    } catch (error) {
      log.warn('Failed to advance read watermark after case post', {
        engagementId,
        conversationId,
        userId: user.id,
        error: errorMessage(error),
      });
    }

    void publishConversationEvent(conversationId, CONVERSATION_EVENT_MESSAGE, messageView);

    // ── ⚠⚠ POST-COMMIT AND POST-BROADCAST. NOTHING BELOW MAY FAIL THIS MESSAGE. ──
    // The row is persisted and the Ably event is already on the wire, so a failure here would
    // toast "could not send" for a message the sender can SEE in the thread — and the retry
    // would DOUBLE-POST. Both reads are therefore individually `.catch`-guarded:
    //   · the case title degrades to a neutral label;
    //   · the recipient lookup degrades to NO fan-out. `resolveCaseNotifyTargets` reaches
    //     `companiesRepository.findOwnerUserIdByCompanyId` on the expert lens, which its own
    //     docblock says still THROWS on a transient DB error so a caller can retry — but this
    //     caller must not, and cannot. A missed notification is strictly better than a
    //     duplicated message.
    const { title: caseTitle, targets } = await resolveCaseNotifyContext({
      access,
      engagementId,
      conversationId,
      userId: user.id,
      findCaseTitle: (id) => caseEngagementsRepository.findByEngagementId(id),
      onTargetsFailed: (error) => {
        log.warn('Case notify target resolution failed after commit — no fan-out', {
          engagementId,
          conversationId,
          userId: user.id,
          error: errorMessage(error),
        });
      },
    });
    if (targets !== undefined) {
      publishCaseMessagePosted({
        access,
        targets,
        title: caseTitle,
        senderName,
        correlationId: row.id,
        preview: previewOfPlainText(plainText),
      });
    }

    log.info('Case conversation message posted', {
      engagementId,
      conversationId,
      userId: user.id,
      messageId: row.id,
    });

    return { success: true, message: messageView };
  } catch (error) {
    log.error('Failed to post case conversation message', {
      engagementId,
      userId: user.id,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not send your message. Please try again.' };
  }
}
