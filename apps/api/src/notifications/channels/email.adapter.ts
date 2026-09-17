import { Worker, type Job } from 'bullmq';
import nodemailer, { type Transporter } from 'nodemailer';
import * as Sentry from '@sentry/node';
import { usersRepository } from '@balo/db';
import { render } from '@react-email/render';
import { createLogger } from '@balo/shared/logging';
import { createRedisConnection } from '../../lib/redis.js';
import { getR2ObjectBytes } from '../../lib/storage/r2.js';
import { readCalendarSmtpConfig } from './calendar-smtp-config.js';
import {
  CalendarInviteSendError,
  deliverCalendarInvite,
  type CalendarInviteTransport,
} from './calendar-invite-delivery.js';
import { getEmailTemplate } from './templates/index.js';
import { logNotification } from './log.js';
import type { DeliveryPayload } from './types.js';

/** BAL-475 — the ONE event this queue may route to the SMTP relay (F25, fix round 1, S12). */
const CALENDAR_INVITE_EVENT = 'meeting.calendar_invite';

const log = createLogger('notification-email');

// Cached SMTP transport — created lazily on first use, matching `getBrevoClient`'s posture.
let calendarSmtpTransport: Transporter | null = null;

/**
 * BAL-475 — the SECOND transport of the email channel, for the CALENDAR message class only.
 * Lazily created, `undefined` when unconfigured (so a delivery SKIPS rather than throwing).
 * Bounded timeouts so a stuck relay can never hold a claim past its lease. `logger: false`,
 * `debug: false` — nodemailer must never log credentials or envelopes.
 *
 * ⚠ F3 (fix round 1, S2/S14) — TLS IS REQUIRED, NEVER OPTIONAL. `secure: false` (port 587) means
 * STARTTLS, and nodemailer's `login()` never checks whether STARTTLS actually ran before sending
 * `AUTH` — a live probe against a fake SMTP server confirmed the relay's credentials go out in
 * PLAINTEXT the moment the server doesn't (or an on-path attacker strips) `250-STARTTLS` from its
 * EHLO reply. `requireTLS: true` makes nodemailer refuse to authenticate without it;
 * `tls: { minVersion: 'TLSv1.2' }` floors the negotiated protocol version WITHOUT touching
 * `rejectUnauthorized` (stays at Node's secure default — certificate verification is never
 * disabled). `disableFileAccess`/`disableUrlAccess` are defence in depth against a future
 * `{ path }` / `{ href }` content object — every value passed today is a plain string.
 *
 * ⚠ THE ONLY VALUE IMPORT OF `nodemailer` IN THE REPO — pinned by
 * `invariants/nodemailer-only-in-email-channel.test.ts`. A second transport inside the ONE
 * email channel, never a second dispatch path.
 */
function getCalendarInviteTransport(): CalendarInviteTransport | undefined {
  const config = readCalendarSmtpConfig();
  if (config === undefined) {
    return undefined;
  }

  if (calendarSmtpTransport === null) {
    calendarSmtpTransport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      ...(config.secure ? {} : { requireTLS: true }),
      tls: { minVersion: 'TLSv1.2' },
      auth: { user: config.user, pass: config.pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }
  const transporter = calendarSmtpTransport;

  return {
    organizerAddress: config.organizerAddress,
    send: async (options) => {
      const info = await transporter.sendMail(options);
      return { messageId: typeof info.messageId === 'string' ? info.messageId : null };
    },
  };
}

/** A Brevo transactional-email attachment (base64 content + download name). */
interface BrevoAttachment {
  content: string;
  name: string;
}

// Cached Brevo client — created lazily on first use
interface BrevoEmailClient {
  transactionalEmails: {
    sendTransacEmail: (params: Record<string, unknown>) => Promise<{ messageId?: string }>;
  };
}

let brevoClient: BrevoEmailClient | null = null;

async function getBrevoClient(): Promise<BrevoEmailClient> {
  if (brevoClient) return brevoClient;

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not configured');
  }

  const { BrevoClient } = await import('@getbrevo/brevo');
  brevoClient = new BrevoClient({ apiKey }) as BrevoEmailClient;
  return brevoClient;
}

/**
 * BAL-386: resolve each attachment spec's bytes from R2 and base64-encode them for
 * Brevo's `attachment` field. On any R2 read failure we log then THROW so the whole
 * job re-throws and BullMQ retries (the bytes are guaranteed present by apps/web's
 * force-generate at share time, so a miss is transient). Returns `undefined` when
 * there are no attachments so the non-attachment path is unchanged.
 */
async function resolveAttachments(
  payload: DeliveryPayload
): Promise<BrevoAttachment[] | undefined> {
  const specs = payload.attachments;
  if (!specs || specs.length === 0) return undefined;

  const resolved: BrevoAttachment[] = [];
  for (const spec of specs) {
    try {
      const bytes = await getR2ObjectBytes(spec.key);
      resolved.push({
        content: Buffer.from(bytes).toString('base64'),
        name: spec.filename,
      });
    } catch (error) {
      log.warn(
        {
          key: spec.key,
          template: payload.template,
          error: error instanceof Error ? error.message : String(error),
        },
        'Proposal PDF attachment read failed'
      );
      throw error; // Re-throw so the job fails and BullMQ retries.
    }
  }
  return resolved;
}

/**
 * BAL-275 (D6) — non-production refuses to send REAL mail unless deliberately opted in.
 *
 * ⚠ PRODUCTION-INERT BY CONSTRUCTION. The first clause returns `false` when
 * `NODE_ENV === 'production'`, so production never reads `DEV_ALLOW_REAL_EMAIL` at all: a stray
 * value of that variable in a production environment cannot change one byte of behaviour.
 * Pinned by `email.processor.test.ts`'s two production-inertness cases.
 *
 * ⚠ FAILS CLOSED. Absent an exact `'true'`, non-production does NOT send. An unset, empty,
 * misspelt or `'false'` value all block.
 */
export function devEmailSendIsBlocked(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.DEV_ALLOW_REAL_EMAIL !== 'true';
}

/**
 * F4 (fix round 1, R3) — the calendar-class branch, extracted so `processEmailJob` itself stays
 * under the repo's Sonar cognitive-complexity limit. F25 (S12) gates on the event name (defence
 * in depth — the dispatcher already gates on it too); F14 (R13) sanitises and rethrows any
 * non-send failure, capturing it to Sentry only on the FINAL attempt (a `CalendarInviteSendError`
 * is already sanitised and already captured inside `deliverCalendarInvite` itself).
 */
async function processCalendarInviteJob(job: Job<DeliveryPayload>): Promise<void> {
  const payload = job.data;

  if (payload.event !== CALENDAR_INVITE_EVENT) {
    log.error(
      { template: payload.template, event: payload.event },
      'A non-calendar-invite event carried a calendarInvite payload — refusing to route to SMTP'
    );
    Sentry.captureMessage('A non-calendar-invite event carried a calendarInvite payload', {
      level: 'error',
      extra: { template: payload.template, event: payload.event },
    });
    await logNotification(payload, 'email', 'skipped', 'calendar_invite_event_mismatch');
    return;
  }

  try {
    await deliverCalendarInvite(job, getCalendarInviteTransport());
  } catch (error) {
    if (error instanceof CalendarInviteSendError) {
      throw error;
    }
    const attempts = job.opts.attempts ?? 1;
    const sanitized = new Error(
      `Calendar invite delivery failed: ${error instanceof Error ? error.name : 'UnknownError'}`
    );
    if (job.attemptsMade + 1 >= attempts) {
      Sentry.captureException(sanitized, {
        extra: { jobId: job.id, template: payload.template, event: payload.event },
      });
    }
    throw sanitized;
  }
}

/** Exported for testability — called by the BullMQ worker. */
export async function processEmailJob(job: Job<DeliveryPayload>): Promise<void> {
  const payload = job.data;

  if (devEmailSendIsBlocked()) {
    // ⚠ NEVER log an address — we return BEFORE `toEmail` is resolved, so structurally we cannot.
    log.info(
      { template: payload.template, recipientId: payload.recipientId },
      'Email send blocked outside production (set DEV_ALLOW_REAL_EMAIL=true to allow)'
    );
    await logNotification(payload, 'email', 'skipped', 'Blocked outside production');
    return; // ⚠ RETURN, never throw — a throw would make BullMQ retry this forever.
  }

  // BAL-475 — transport selected by MESSAGE CLASS: calendar ⇒ SMTP relay; everything else ⇒
  // Brevo API. Placed HERE, immediately after the dev block, so that block covers BOTH
  // transports by position — no separate dev-send guard for the calendar path.
  if (payload.calendarInvite !== undefined) {
    await processCalendarInviteJob(job);
    return;
  }

  // 1. Resolve recipient email + display name.
  //    A literal `recipientEmail` (e.g. the ops/admin inbox) bypasses the user
  //    lookup; otherwise resolve the user by id.
  let toEmail: string;
  let recipientName: string;
  if (payload.recipientEmail) {
    toEmail = payload.recipientEmail;
    recipientName = 'team';
  } else {
    const user = await usersRepository.findById(payload.recipientId);
    if (!user?.email) {
      log.warn({ recipientId: payload.recipientId }, 'No email for recipient');
      await logNotification(payload, 'email', 'skipped', 'No email address');
      return;
    }
    toEmail = user.email;
    recipientName = user.firstName ?? 'there';
  }

  // 2. Render template
  const { component, subject } = getEmailTemplate(payload.template, {
    ...payload.data,
    ...payload.payload,
    recipientName,
  });

  const html = await render(component);

  // 3. Send via Brevo
  try {
    const client = await getBrevoClient();

    // BAL-386: resolve any R2-backed attachments to base64 BEFORE sending. A read
    // failure throws here → BullMQ retries; the non-attachment path passes undefined
    // and is unchanged.
    const attachment = await resolveAttachments(payload);

    const result = await client.transactionalEmails.sendTransacEmail({
      htmlContent: html,
      sender: {
        email: process.env.BREVO_SENDER_EMAIL ?? 'notifications@balo.expert',
        name: 'Balo',
      },
      subject,
      to: [{ email: toEmail, name: recipientName }],
      ...(attachment ? { attachment } : {}),
    });
    const messageId = result?.messageId;

    await logNotification(payload, 'email', 'sent', undefined, {
      brevoMessageId: messageId,
    });
    // ⚠ NEVER LOG `toEmail`. For an EXTERNAL recipient (`payload.recipientEmail`) that is a
    // NON-USER THIRD PARTY's address — a meeting guest, a referral invitee, a proposal
    // share recipient — i.e. exactly the PII class the dispatcher's own external-recipient
    // block exists to keep out of the structured log ("the invitee's raw address never
    // lands in the structured dispatcher log or the BullMQ jobId"). This line used to
    // reintroduce it one hop later, on the success path, for every external send.
    // `recipientId` IS the correlationId on that path, so a support case is still
    // traceable to the exact row without the address.
    log.info(
      {
        template: payload.template,
        recipientId: payload.recipientId,
        external: payload.recipientEmail !== undefined,
        messageId,
      },
      'Email sent'
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await logNotification(payload, 'email', 'failed', errorMessage);
    log.error(
      {
        template: payload.template,
        recipientId: payload.recipientId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Email delivery failed'
    );
    throw error; // Re-throw so BullMQ retries
  }
}

export function startEmailWorker(): Worker<DeliveryPayload> {
  const worker = new Worker<DeliveryPayload>('notification-email', processEmailJob, {
    connection: createRedisConnection(),
    concurrency: 5,
  });

  worker.on('failed', (job, err) => {
    log.error(
      {
        jobId: job?.id,
        template: job?.data?.template,
        error: err.message,
      },
      'Email worker job failed'
    );
  });

  return worker;
}
