import { Worker, type Job } from 'bullmq';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../../lib/redis.js';
import { notificationRules, type RuleContext } from './rules.js';
import { resolveContext } from './resolver.js';
import { dispatch } from './dispatcher.js';
import { scheduleConversationUnreadDigest } from '../scheduling/conversation-unread.js';

const log = createLogger('notification-engine');

interface NotificationEventJobData {
  event: string;
  payload: Record<string, unknown>;
  publishedAt: string;
}

/** A string field off an untyped payload, or `undefined`. */
function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The standard Pino error fields, hoisted out of the catch blocks below. Both `catch`es sit
 * one level deep, so inlining these two ternaries costs +3 each against the enclosing
 * function's Cognitive Complexity — enough on its own to breach SonarCloud's limit of 15.
 */
function errorFields(error: unknown): { error: string; stack: string | undefined } {
  return {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

/**
 * BAL-424 — resolve the digest's RECIPIENT USER ID from the already-hydrated context.
 *
 * The client arm carries it directly (`payload.recipientId`). The expert arm carries an
 * `expertProfileId` on the wire, which `resolveContext` has already turned into
 * `data.expert.user.id` — which is precisely WHY the follow-up runs after hydration: the
 * fire-time recheck reads `conversation_read_states` by (conversation, USER) and cannot
 * resolve a profile into a user inside the guard.
 */
function digestRecipientUserId(ctx: RuleContext): string | undefined {
  if (ctx.payload.recipientRole === 'client') {
    return payloadString(ctx.payload, 'recipientId');
  }
  const expert = ctx.data.expert as { user?: { id?: string } } | undefined;
  return expert?.user?.id;
}

/**
 * BAL-424 — schedule the debounced unread digest for ONE conversation event.
 *
 * ⚠ BOTH `conversation.message_posted` AND `conversation.file_shared` ROUTE HERE, and both
 * land on the SAME dedupe key. That is what makes a message plus a file inside one 10-minute
 * window ONE email rather than two. The event name only decides which optional field SEEDS
 * the stored payload — the guard rebuilds both from live state at fire time.
 */
async function scheduleConversationUnreadDigestFromContext(ctx: RuleContext): Promise<void> {
  const conversationId = payloadString(ctx.payload, 'conversationId');
  const contextId = payloadString(ctx.payload, 'contextId');
  const contextType = ctx.payload.contextType;
  const recipientUserId = digestRecipientUserId(ctx);
  const recipientRole = ctx.payload.recipientRole;

  if (
    conversationId === undefined ||
    contextId === undefined ||
    recipientUserId === undefined ||
    (contextType !== 'relationship' && contextType !== 'engagement') ||
    (recipientRole !== 'client' && recipientRole !== 'expert')
  ) {
    log.warn(
      { event: ctx.event, conversationId, recipientRole },
      'Conversation unread digest not scheduled — incomplete context'
    );
    return;
  }

  const preview =
    ctx.event === 'conversation.message_posted' ? payloadString(ctx.payload, 'preview') : undefined;
  const fileName =
    ctx.event === 'conversation.file_shared' ? payloadString(ctx.payload, 'fileName') : undefined;
  const projectRequestId = payloadString(ctx.payload, 'projectRequestId');
  const engagementId = payloadString(ctx.payload, 'engagementId');

  await scheduleConversationUnreadDigest({
    conversationId,
    contextType,
    contextId,
    recipientUserId,
    recipientRole,
    title: payloadString(ctx.payload, 'title') ?? 'your conversation',
    senderName: payloadString(ctx.payload, 'senderName') ?? 'Someone',
    ...(preview === undefined ? {} : { preview }),
    ...(fileName === undefined ? {} : { fileName }),
    ...(projectRequestId === undefined ? {} : { projectRequestId }),
    ...(engagementId === undefined ? {} : { engagementId }),
  });
}

/**
 * BAL-424 — DEFERRED FOLLOW-UPS. Some events warrant a SECOND, DELAYED event as well as
 * their immediate rules. Scheduling lives here rather than in `apps/web` because
 * `scheduleNotification` is in-process and API-only BY DESIGN (ADR-1047 Decision 11: the
 * schedule/cancel seam is NOT an HTTP surface, and `WEB_SCHEDULABLE_EVENTS` stays empty).
 *
 * Runs AFTER `resolveContext` so a follow-up can use the hydrated `data.expert.user.id` —
 * see {@link digestRecipientUserId}.
 *
 * ⚠ AN EVENT WITH A FOLLOW-UP MUST HAVE AT LEAST ONE RULE, or `processNotificationEvent`
 * returns early at the rules lookup and the follow-up NEVER RUNS. Both conversation events
 * keep their two immediate in-app rules, so both are safe — the warning is restated on those
 * rules in `rules.ts`.
 *
 * ⚠ BOTH ENTRIES POINT AT THE SAME HELPER, WHICH USES THE SAME DEDUPE KEY. That is what
 * makes a message + a file inside one window ONE email rather than two.
 */
const EVENT_FOLLOW_UPS: Partial<Record<string, (ctx: RuleContext) => Promise<void>>> = {
  'conversation.message_posted': scheduleConversationUnreadDigestFromContext,
  'conversation.file_shared': scheduleConversationUnreadDigestFromContext,
};

/** Exported for testability — called by the BullMQ worker. */
export async function processNotificationEvent(job: Job<NotificationEventJobData>): Promise<void> {
  const { event, payload } = job.data;

  log.info({ event, correlationId: payload.correlationId }, 'Processing notification event');

  // 1. Look up rules
  const rules = notificationRules[event];
  if (!rules || rules.length === 0) {
    log.warn({ event }, 'No notification rules found for event');
    return;
  }

  // 2. Hydrate context
  const context = await resolveContext(event, payload);

  // 3. Evaluate each rule and dispatch
  for (const rule of rules) {
    try {
      await dispatch(rule, context);
    } catch (error) {
      log.error(
        { event, template: rule.template, ...errorFields(error) },
        'Failed to dispatch notification rule'
      );
      // Individual rule failure doesn't fail the whole event
    }
  }

  // 4. Deferred follow-up (BAL-424): schedule a SECOND, delayed event where one is warranted.
  //    Isolated in its own try/catch and swallowed — a scheduling hiccup must never fail the
  //    immediate in-app notification that already dispatched above.
  const followUp = EVENT_FOLLOW_UPS[event];
  if (followUp !== undefined) {
    try {
      await followUp(context);
    } catch (error) {
      log.error(
        { event, correlationId: payload.correlationId, ...errorFields(error) },
        'Failed to schedule notification follow-up'
      );
    }
  }
}

export function startNotificationEventWorker(): Worker<NotificationEventJobData> {
  const worker = new Worker<NotificationEventJobData>(
    'notification-events',
    processNotificationEvent,
    {
      connection: createRedisConnection(),
      concurrency: 10,
    }
  );

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, error: err.message }, 'Notification event processing failed');
  });

  return worker;
}
