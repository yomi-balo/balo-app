import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { isValidPhoneNumber, parsePhoneNumber } from 'libphonenumber-js/min';
import { getRedis } from '../../lib/redis.js';
import { requireAuth } from '../../lib/require-auth.js';
import { maskPhone, getBrevoClient } from '../../lib/brevo.js';
import { sendOtpBodySchema } from './schema.js';

// @balo/shared is CJS; static ESM import fails under tsx — use createRequire
const { createLogger } = createRequire(import.meta.url)('@balo/shared/logging');
const log = createLogger('phone-send-otp');

/** Max OTP sends per phone number within the TTL window. */
const MAX_SENDS = 3;
/** Max OTP sends per user within the TTL window. */
const MAX_SENDS_PER_USER = 5;
/** TTL for OTP and send counter in seconds (10 minutes). */
const OTP_TTL_SECONDS = 600;

export async function sendOtpRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post('/phone/send-otp', { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = sendOtpBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_phone',
        details: parsed.error.issues.map((i: { message: string }) => i.message),
      });
    }

    const { phone } = parsed.data;
    const userId = request.userId!;
    const masked = maskPhone(phone);

    // 1. Validate phone number with libphonenumber-js
    if (!isValidPhoneNumber(phone)) {
      return reply.status(400).send({ error: 'invalid_phone' });
    }

    // 2. Reject landlines
    let numberType: string | undefined;
    try {
      const phoneNumber = parsePhoneNumber(phone);
      numberType = phoneNumber.getType();
    } catch {
      return reply.status(400).send({ error: 'invalid_phone' });
    }
    if (numberType === 'FIXED_LINE') {
      return reply.status(400).send({ error: 'landline_not_supported' });
    }

    // 3. Rate limit checks
    const redis = getRedis();

    // 3a. Per-user rate limit (checked first)
    const userCountKey = `otp:sends:user:${userId}`;
    const userCount = await redis.get(userCountKey);
    const userSendCount = userCount ? parseInt(userCount, 10) : 0;

    if (userSendCount >= MAX_SENDS_PER_USER) {
      const ttl = await redis.ttl(userCountKey);
      log.warn({ userId, sendCount: userSendCount }, 'OTP user rate limited');
      return reply.status(429).send({
        error: 'rate_limited',
        cooldownSeconds: ttl > 0 ? ttl : OTP_TTL_SECONDS,
      });
    }

    // 3b. Per-phone rate limit
    const sendCountKey = `otp:sends:${phone}`;
    const currentCount = await redis.get(sendCountKey);
    const sendCount = currentCount ? parseInt(currentCount, 10) : 0;

    if (sendCount >= MAX_SENDS) {
      const ttl = await redis.ttl(sendCountKey);
      log.warn({ phone: masked, sendCount }, 'OTP rate limited');
      return reply.status(429).send({
        error: 'rate_limited',
        cooldownSeconds: ttl > 0 ? ttl : OTP_TTL_SECONDS,
      });
    }

    // 4. Generate cryptographically secure 6-digit code
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

    // 5. Store in Redis with TTL
    const otpKey = `otp:${phone}`;
    await redis.set(otpKey, JSON.stringify({ code, attempts: 0 }), 'EX', OTP_TTL_SECONDS);

    // 6. Increment send counters with TTL (atomic pipeline)
    const pipeline = redis.pipeline();
    pipeline.incr(sendCountKey);
    pipeline.expire(sendCountKey, OTP_TTL_SECONDS);
    pipeline.incr(userCountKey);
    pipeline.expire(userCountKey, OTP_TTL_SECONDS);
    await pipeline.exec();

    // 7. Send SMS via Brevo
    try {
      const client = await getBrevoClient();
      await client.transactionalSms.sendTransacSms({
        sender: process.env.BREVO_SMS_SENDER ?? 'Balo',
        recipient: phone,
        content: `Your Balo verification code is ${code}. Valid for 10 minutes.`,
        type: 'transactional',
      });

      log.info({ phone: masked, userId }, 'OTP sent');
      return reply.send({ sent: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(
        {
          phone: masked,
          userId,
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        },
        'OTP SMS delivery failed'
      );
      return reply.status(502).send({ error: 'brevo_rejected' });
    }
  });
}
