import { Worker, type Job } from 'bullmq';
import { usersRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  trackServer,
  CALL_NOW_SERVER_EVENTS,
  MEETING_SERVER_EVENTS,
  NOTIFICATION_SERVER_EVENTS,
} from '@balo/analytics/server';
import { createRedisConnection, getRedis } from '../../lib/redis.js';
import { checkRateLimit, type RateLimitConfig } from '../../lib/rate-limiter.js';
import { maskPhone, getBrevoClient } from '../../lib/brevo.js';
import { getSmsTemplate } from './templates/sms-templates.js';
import { logNotification } from './log.js';
import type { DeliveryPayload } from './types.js';

const log = createLogger('notification-sms');

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

export const CLIENT_SMS_NOT_OPTED_IN = 'Client SMS not opted in';

const SMS_RATE_LIMIT: RateLimitConfig = {
  keyPrefix: 'sms:rate',
  maxRequests: 5,
  windowSeconds: 3600,
};

/**
 * BAL-652 — `call_sms_sent`, once Brevo has accepted a `call.ringing` SMS. `distinct_id` is the
 * CALLER, matching `call_sms_suppressed`; the SMS's own recipient is the callee.
 *
 * ⚠ NEVER THROWS. It runs after the send succeeded, and a throw would reach the delivery catch
 * below, which re-throws for a BullMQ retry and would send the SMS twice.
 */
function trackCallSmsSent(payload: DeliveryPayload): void {
  if (payload.event !== 'call.ringing') {
    return;
  }
  const { ringId, callerUserId } = payload.payload;
  if (typeof ringId !== 'string' || typeof callerUserId !== 'string') {
    return;
  }
  try {
    trackServer(CALL_NOW_SERVER_EVENTS.SMS_SENT, {
      audience: payload.recipientSide ?? 'client',
      ring_id: ringId,
      distinct_id: callerUserId,
    });
  } catch (error) {
    log.warn(
      { ringId, error: error instanceof Error ? error.message : String(error) },
      'Failed to track call_sms_sent'
    );
  }
}

const WAITING_SMS_EVENTS: ReadonlySet<string> = new Set([
  'meeting.waiting_for_client',
  'meeting.waiting_for_expert',
]);

/**
 * BAL-654 — `waiting_sms_sent`, once Brevo has accepted a waiting-party SMS. `distinct_id` is the
 * MEETING id: there is no acting human, the recipient is the absent party.
 *
 * ⚠ NEVER THROWS, for the reason {@link trackCallSmsSent} gives.
 */
function trackWaitingSmsSent(payload: DeliveryPayload): void {
  if (!WAITING_SMS_EVENTS.has(payload.event)) {
    return;
  }
  const { meetingId, scheduledStartIso } = payload.payload;
  if (typeof meetingId !== 'string' || typeof scheduledStartIso !== 'string') {
    return;
  }
  try {
    trackServer(MEETING_SERVER_EVENTS.WAITING_SMS_SENT, {
      meeting_id: meetingId,
      audience: payload.recipientSide ?? 'client',
      seconds_after_start: Math.round((Date.now() - Date.parse(scheduledStartIso)) / 1000),
      distinct_id: meetingId,
    });
  } catch (error) {
    log.warn(
      { meetingId, error: error instanceof Error ? error.message : String(error) },
      'Failed to track waiting_sms_sent'
    );
  }
}

/** Exported for testability — called by the BullMQ worker. */
export async function processSmsJob(job: Job<DeliveryPayload>): Promise<void> {
  const payload = job.data;

  // 1. Resolve recipient phone
  const user = await usersRepository.findById(payload.recipientId);
  if (!user?.phone) {
    log.warn({ recipientId: payload.recipientId }, 'No phone for recipient');
    await logNotification(payload, 'sms', 'skipped', 'No phone number');
    trackServer(NOTIFICATION_SERVER_EVENTS.SMS_SKIPPED, {
      template: payload.template,
      skip_reason: 'No phone number',
      distinct_id: payload.recipientId,
    });
    return;
  }

  // 2. Validate E.164 format
  if (!E164_REGEX.test(user.phone)) {
    log.warn({ recipientId: payload.recipientId }, 'Invalid phone number format');
    await logNotification(payload, 'sms', 'skipped', 'Invalid phone number format');
    trackServer(NOTIFICATION_SERVER_EVENTS.SMS_SKIPPED, {
      template: payload.template,
      skip_reason: 'Invalid phone number format',
      distinct_id: payload.recipientId,
    });
    return;
  }

  // Fix round 1 item 17 (security LOW) — the STRUCTURAL guard, not just the shape checks
  // above. "Has a phone ⇒ verified" previously rested entirely on the convention that
  // `usersRepository.setPhoneVerified` is the sole writer of `users.phone` — true today
  // (verified by grep), but a convention, not a constraint, and this is the first SMS rule to
  // depend on it. Checking `phoneVerifiedAt` here removes that dependency at zero cost.
  if (!user.phoneVerifiedAt) {
    log.warn({ recipientId: payload.recipientId }, 'Phone not verified for recipient');
    await logNotification(payload, 'sms', 'skipped', 'Phone not verified');
    trackServer(NOTIFICATION_SERVER_EVENTS.SMS_SKIPPED, {
      template: payload.template,
      skip_reason: 'Phone not verified',
      distinct_id: payload.recipientId,
    });
    return;
  }

  // Client-side SMS needs explicit consent (BAL-655). A missing side counts as 'client', so a job
  // queued by a build that predates `recipientSide` fails closed.
  if (payload.recipientSide !== 'expert' && !user.clientSmsOptedInAt) {
    log.info({ recipientId: payload.recipientId }, 'Client SMS not opted in');
    await logNotification(payload, 'sms', 'skipped', CLIENT_SMS_NOT_OPTED_IN);
    trackServer(NOTIFICATION_SERVER_EVENTS.SMS_SKIPPED, {
      template: payload.template,
      skip_reason: CLIENT_SMS_NOT_OPTED_IN,
      distinct_id: payload.recipientId,
    });
    return;
  }

  // 3. Rate-limit check (fail-open: Redis errors let the SMS through)
  try {
    const rateLimitResult = await checkRateLimit(getRedis(), SMS_RATE_LIMIT, payload.recipientId);
    if (!rateLimitResult.allowed) {
      log.warn(
        { recipientId: payload.recipientId, current: rateLimitResult.current },
        'SMS rate limit exceeded'
      );
      await logNotification(payload, 'sms', 'skipped', 'Rate limit exceeded');
      trackServer(NOTIFICATION_SERVER_EVENTS.SMS_SKIPPED, {
        template: payload.template,
        skip_reason: 'Rate limit exceeded',
        distinct_id: payload.recipientId,
      });
      return;
    }
  } catch (error) {
    log.warn(
      {
        recipientId: payload.recipientId,
        error: error instanceof Error ? error.message : String(error),
      },
      'SMS rate limit check failed — allowing SMS through'
    );
  }

  // 4. Render template
  const body = getSmsTemplate(payload.template, {
    ...payload.data,
    ...payload.payload,
  });

  if (body.length > 160) {
    log.warn(
      { template: payload.template, length: body.length },
      'SMS body exceeds 160 characters — message may be split and billed as multiple SMS'
    );
  }

  // 5. Send via Brevo
  try {
    const client = await getBrevoClient();

    const result = await client.transactionalSms.sendTransacSms({
      sender: process.env.BREVO_SMS_SENDER ?? 'Balo',
      recipient: user.phone,
      content: body,
      type: 'transactional',
    });
    const messageId = result?.messageId;

    await logNotification(payload, 'sms', 'sent', undefined, {
      brevoMessageId: messageId,
    });
    trackServer(NOTIFICATION_SERVER_EVENTS.SMS_SENT, {
      template: payload.template,
      recipient_phone_masked: maskPhone(user.phone),
      distinct_id: payload.recipientId,
    });
    trackCallSmsSent(payload);
    trackWaitingSmsSent(payload);
    log.info({ template: payload.template, messageId }, 'SMS sent');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logNotification(payload, 'sms', 'failed', errorMessage);
    trackServer(NOTIFICATION_SERVER_EVENTS.SMS_FAILED, {
      template: payload.template,
      error_type: errorMessage,
      distinct_id: payload.recipientId,
    });
    log.error(
      {
        template: payload.template,
        recipientId: payload.recipientId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      },
      'SMS delivery failed'
    );
    throw error; // Re-throw so BullMQ retries
  }
}

export function startSmsWorker(): Worker<DeliveryPayload> {
  const worker = new Worker<DeliveryPayload>('notification-sms', processSmsJob, {
    connection: createRedisConnection(),
    concurrency: 3,
  });

  worker.on('failed', (job, err) => {
    log.error(
      {
        jobId: job?.id,
        template: job?.data?.template,
        error: err.message,
      },
      'SMS worker job failed'
    );
  });

  return worker;
}
