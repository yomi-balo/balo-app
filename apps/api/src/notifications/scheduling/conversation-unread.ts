import { randomUUID } from 'node:crypto';
import { conversationsRepository, usersRepository, type ConversationUnreadSummary } from '@balo/db';
import { previewOfHtmlBody } from '@balo/shared/notifications';
import { createLogger } from '@balo/shared/logging';
import { scheduleNotification } from './schedule.js';
import type { ScheduledRecheck } from './rechecks.js';

const log = createLogger('conversation-unread-digest');

/**
 * BAL-424 — the 10-minute debounced unread DIGEST, and BAL-420's FIRST consumer.
 * `SCHEDULED_RECHECKS` shipped EMPTY and named "BAL-424 (conversation unread)" in its
 * docblock; this is that guard.
 *
 * IN-APP STAYS IMMEDIATE. Only the EMAIL debounces. The shipped in-app-only rules are
 * AMENDED, not replaced: `conversation.message_posted` and `conversation.file_shared` each
 * keep their two immediate in-app rules, and each schedules this SECOND, EMAIL-only event 10
 * minutes out.
 *
 * ⚠⚠ MESSAGES AND FILES SHARE ONE PROMISE, ON ONE KEY (owner ruling, 2026-08-11). The key is
 * `(conversationId, recipientUserId)` — it names NEITHER the message NOR the file — so a
 * message at T+0 and a file at T+3min fold into the SAME pending row and produce ONE email.
 * That is why both publishers call the same helper and why the guard below counts both.
 *
 * ⚠⚠ THE RECHECK IS THE AUTHORITY, THE KEY IS NOT. `scheduleNotification`'s dedup folds on a
 * partial unique over `status = 'pending'` ONLY. From the instant the tick CLAIMS a row until
 * its terminal mark — normally one publish, but ~15 minutes if a send strands its claim
 * (5-min TTL × 3 attempts) — the key's slot is OPEN, and a concurrent schedule INSERTS A
 * SECOND PROMISE in BOTH modes. So two emails can land closer together than 10 minutes, with
 * only this guard between them. DO NOT read the dedup key as a rate limit; DO NOT try to
 * close the gap by widening the arbiter (that is the mid-send mutation `cancel` deliberately
 * refuses).
 *
 * ⚠ `first_wins`, NOT `replace_pending`. The window must be anchored on the FIRST unread
 * activity, not pushed out by every subsequent one — otherwise a fast exchange never sends at
 * all. Activity arriving inside the window folds into the same promise, and the guard rebuilds
 * the payload from live state at fire time, so the email reflects everything unread.
 *
 * ⚠ THE REBUILT PAYLOAD MUST KEEP `correlationId`. The tick re-validates it and fails the row
 * terminally when it is missing, because `publisher.publish` derives the BullMQ jobId from it.
 * SPREAD the stored payload (`{ ...row.payload, ...whatChanged }`) — never build fresh.
 */

/**
 * Dedup + cancel handle: one pending promise per (conversation, recipient).
 *
 * ⚠ IT NAMES NEITHER THE MESSAGE NOR THE FILE — that is exactly what makes the two publishers
 * coalesce into one email.
 */
export function conversationUnreadKey(conversationId: string, recipientUserId: string): string {
  return `conversation-unread:${conversationId}:${recipientUserId}`;
}

/** The debounce window. Ten minutes: long enough to coalesce a burst, short enough to matter. */
export const CONVERSATION_UNREAD_DELAY_MS = 10 * 60 * 1000;

/** The registry key under which {@link conversationUnreadRecheck} is registered. */
export const CONVERSATION_UNREAD_RECHECK = 'conversation_unread';

/**
 * THE FIRE-TIME GUARD. Re-reads live state and answers whether the email is still owed.
 *
 * ⚠ UNREAD MEANS MESSAGES **OR** FILES. The definition is `listThreadSummaries`'s
 * `latestInboundActivityAt`, BORROWED (via `unreadSummaryFor`, which mirrors it) rather than
 * restated — a file can arrive with no message at all, and skipping on
 * `unreadMessageCount === 0` alone would mean a FILE-ONLY exchange produced an in-app
 * notification and NO EMAIL, EVER. Two definitions of "unread" would also let the tab strip
 * show a badge while this guard skipped the send.
 */
export const conversationUnreadRecheck: ScheduledRecheck = async (row) => {
  const { conversationId, recipientUserId } = row.payload;
  if (typeof conversationId !== 'string' || typeof recipientUserId !== 'string') {
    // A row written by an older build, or hand-edited. Skipped, never published blind.
    return { publish: false, reason: 'malformed_payload' };
  }

  const summary = await conversationsRepository.unreadSummaryFor({
    conversationId,
    viewerUserId: recipientUserId,
  });

  const unreadTotal = summary.unreadMessageCount + summary.unreadFileCount;
  if (summary.latestInboundAt === null || unreadTotal === 0) {
    // THE WATERMARK PASSED THE ACTIVITY — a NORMAL outcome (`skip_reason`, info), not a
    // failure. The recipient read the thread inside the debounce window.
    return { publish: false, reason: 'read_before_send' };
  }

  /**
   * ⚠⚠ THE TWO PREVIEW LEGS ARE REBUILT AS A PAIR — BOTH SET, EVERY TIME, EVEN TO
   * `undefined`. `unreadSummaryFor` populates EXACTLY ONE of body/fileName (whichever leg is
   * newest; a tie goes to the message), so a spread that only ever ADDS keys would let the
   * leg seeded at SCHEDULE time survive when the OTHER leg wins at fire time: a message
   * preview rendered under a "1 new file" headline, contradicting the payload's own
   * "absent on a file-only exchange" contract. Explicit `undefined` clears the stale leg.
   */
  const preview =
    summary.latestInboundBody === null ? undefined : previewOfHtmlBody(summary.latestInboundBody);
  const fileName = summary.latestInboundFileName ?? undefined;

  return {
    publish: true,
    payload: {
      // ⚠ SPREAD FIRST — it carries `correlationId` (the occurrence id minted at schedule
      // time; see `scheduleConversationUnreadDigest`) and every anchor field. Building fresh
      // would collapse this event into the single BullMQ job `event--undefined`.
      ...row.payload,
      unreadMessageCount: summary.unreadMessageCount,
      unreadFileCount: summary.unreadFileCount,
      latestActivityAtIso: summary.latestInboundAt.toISOString(),
      preview,
      fileName,
      /**
       * ⚠ `senderName` IS REBUILT, NOT INHERITED. The stored value names whoever triggered
       * the FIRST activity in the window; by fire time the newest unread activity may be a
       * different person, or the window may have coalesced several. Inheriting it
       * MISATTRIBUTES the email. Resolved from the live newest-inbound author, and dropped to
       * a neutral label when the digest spans more than one sender, which the subject line
       * and greeting both read honestly.
       */
      senderName: await resolveDigestSenderName(summary, row.payload.senderName),
    },
  };
};

/**
 * Who the digest should name, from the state the guard just read.
 *
 * · one sender  → that person's display name (resolved from the newest inbound activity);
 * · several     → `null`, and the template says "your conversation" instead of a name. A
 *                 coalesced window legitimately spans two people; naming only the newest
 *                 would be a quiet lie about who wrote the other three messages.
 * · unresolvable→ the STORED name, which is at least a real participant.
 */
async function resolveDigestSenderName(
  summary: ConversationUnreadSummary,
  storedName: unknown
): Promise<string | null> {
  if (summary.distinctInboundSenderCount > 1) {
    return null;
  }
  const senderUserId = summary.latestInboundSenderUserId;
  if (senderUserId === null) {
    return typeof storedName === 'string' ? storedName : null;
  }
  const user = await usersRepository.findById(senderUserId);
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(' ').trim();
  if (name.length > 0) {
    return name;
  }
  return typeof storedName === 'string' ? storedName : null;
}

export interface ScheduleConversationUnreadDigestInput {
  conversationId: string;
  contextType: 'relationship' | 'engagement';
  contextId: string;
  recipientUserId: string;
  recipientRole: 'client' | 'expert';
  title: string;
  senderName: string;
  preview?: string;
  fileName?: string;
  projectRequestId?: string;
  engagementId?: string;
}

/**
 * THE ONE SCHEDULER, CALLED BY BOTH PUBLISHERS (via the worker's follow-up hook).
 *
 * `first_wins` on a key that names only the (conversation, recipient) pair means the second
 * caller inside the window is a cheap no-op (`already_pending`) rather than a second email —
 * whether that second caller was a message or a file share.
 *
 * The stored `preview` / `fileName` / counts are only the DEFAULT answer: the guard rebuilds
 * all of them from live state at fire time. They matter solely if the guard is ever removed.
 */
export async function scheduleConversationUnreadDigest(
  input: ScheduleConversationUnreadDigestInput
): Promise<void> {
  const { conversationId, recipientUserId } = input;
  const { outcome } = await scheduleNotification(
    'conversation.unread_digest_due',
    {
      /**
       * ⚠⚠ AN OCCURRENCE ID, MINTED PER PROMISE — **NOT** `${conversationId}:${recipientUserId}`.
       *
       * `publisher.publish` derives the BullMQ jobId from this
       * (`jobId = \`${event}--${correlationId}\``) and `lib/queue.ts` retains completed jobs
       * `{ count: 100 }` on ONE SHARED queue. A value stable per (conversation, recipient)
       * FOREVER therefore collides with its own earlier send for as long as that jobId sits
       * in the completed set — at pre-launch volume, days — and `queue.add` silently NO-OPS
       * while the dispatch tick still marks the row `published`.
       *
       * That is reachable on a completely ordinary path: digest #1 sends at T+10; the
       * recipient reads at T+11; the counterparty writes again at T+40; the T+50 digest is
       * never delivered and nothing anywhere records a failure. This is a DELIBERATE
       * DEVIATION from the plan (§8.2), which specifies the pair-scoped value and calls it
       * "stable per promise" — it is stable per PAIR, forever, which is the defect.
       *
       * A fresh uuid per promise is the house pattern for an event that legitimately repeats
       * (`project.billing_reminder` mints one per click for exactly this reason; the
       * auto-accept / onboarding / dormancy / review-nudge sweeps all carry a discriminator).
       *
       * ⚠ IT IS STABLE ACROSS THE RECHECK'S REBUILD OF *THIS* PROMISE, which is the other
       * half of the requirement: the guard SPREADS `row.payload`, so a stranded send that is
       * re-claimed and re-published still dedupes against itself. Uniqueness comes from the
       * ROW, not from the send.
       *
       * ⚠ `first_wins` means a second `schedule()` inside the window does not insert, so its
       * freshly-minted uuid is discarded with the rest of that payload — one uuid per row.
       */
      correlationId: randomUUID(),
      conversationId,
      contextType: input.contextType,
      contextId: input.contextId,
      recipientUserId,
      recipientRole: input.recipientRole,
      title: input.title,
      senderName: input.senderName,
      unreadMessageCount: 0,
      unreadFileCount: 0,
      latestActivityAtIso: new Date().toISOString(),
      ...(input.preview === undefined ? {} : { preview: input.preview }),
      ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
      ...(input.projectRequestId === undefined ? {} : { projectRequestId: input.projectRequestId }),
      ...(input.engagementId === undefined ? {} : { engagementId: input.engagementId }),
    },
    {
      key: conversationUnreadKey(conversationId, recipientUserId),
      delayMs: CONVERSATION_UNREAD_DELAY_MS,
      mode: 'first_wins',
      recheck: CONVERSATION_UNREAD_RECHECK,
    }
  );

  log.info({ conversationId, recipientUserId, outcome }, 'Conversation unread digest scheduled');
}
