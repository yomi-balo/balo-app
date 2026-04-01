import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { isValidPhoneNumber, parsePhoneNumber } from 'libphonenumber-js/min';
import type { Redis } from 'ioredis';
import { createLogger } from '@balo/shared/logging';
import { getRedis } from '../../lib/redis.js';
import { requireAuth } from '../../lib/require-auth.js';
import { maskPhone, getBrevoClient } from '../../lib/brevo.js';
import { sendOtpBodySchema } from './schema.js';

const log = createLogger('phone-send-otp');

/** Max OTP sends per phone number within the TTL window. */
const MAX_SENDS = 3;
/** Max OTP sends per user within the TTL window. */
const MAX_SENDS_PER_USER = 5;
/** TTL for OTP and send counter in seconds (10 minutes). */
const OTP_TTL_SECONDS = 600;

/** Validate and parse the request body + phone number. Returns phone or sends an error reply. */
function validateRequest(
  request: FastifyRequest,
  reply: FastifyReply
): { phone: string; userId: string; masked: string } | null {
  const parsed = sendOtpBodySchema.safeParse(request.body);
  if (!parsed.success) {
    reply.status(400).send({
      error: 'invalid_phone',
      details: parsed.error.issues.map((i: { message: string }) => i.message),
    });
    return null;
  }

  const { phone } = parsed.data;

  if (!isValidPhoneNumber(phone)) {
    reply.status(400).send({ error: 'invalid_phone' });
    return null;
  }

  let numberType: string | undefined;
  try {
    const phoneNumber = parsePhoneNumber(phone);
    numberType = phoneNumber.getType();
  } catch {
    reply.status(400).send({ error: 'invalid_phone' });
    return null;
  }
  if (numberType === 'FIXED_LINE') {
    reply.status(400).send({ error: 'landline_not_supported' });
    return null;
  }

  return { phone, userId: request.userId!, masked: maskPhone(phone) };
}

/** Check per-user and per-phone rate limits. Returns true if the request should be blocked. */
async function checkRateLimits(
  redis: Redis,
  userId: string,
  phone: string,
  masked: string,
  reply: FastifyReply
): Promise<boolean> {
  // Per-user rate limit
  const userCountKey = `otp:sends:user:${userId}`;
  const userCount = await redis.get(userCountKey);
  const userSendCount = userCount ? Number.parseInt(userCount, 10) : 0;

  if (userSendCount >= MAX_SENDS_PER_USER) {
    const ttl = await redis.ttl(userCountKey);
    log.warn({ userId, sendCount: userSendCount }, 'OTP user rate limited');
    reply.status(429).send({
      error: 'rate_limited',
      cooldownSeconds: ttl > 0 ? ttl : OTP_TTL_SECONDS,
    });
    return true;
  }

  // Per-phone rate limit
  const sendCountKey = `otp:sends:${phone}`;
  const currentCount = await redis.get(sendCountKey);
  const sendCount = currentCount ? Number.parseInt(currentCount, 10) : 0;

  if (sendCount >= MAX_SENDS) {
    const ttl = await redis.ttl(sendCountKey);
    log.warn({ phone: masked, sendCount }, 'OTP rate limited');
    reply.status(429).send({
      error: 'rate_limited',
      cooldownSeconds: ttl > 0 ? ttl : OTP_TTL_SECONDS,
    });
    return true;
  }

  return false;
}

/** Generate OTP, store in Redis, increment counters, and send SMS. */
async function generateAndSendOtp(
  redis: Redis,
  phone: string,
  masked: string,
  userId: string,
  reply: FastifyReply
): Promise<void> {
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

  const otpKey = `otp:${phone}`;
  await redis.set(otpKey, JSON.stringify({ code, attempts: 0 }), 'EX', OTP_TTL_SECONDS);

  const userCountKey = `otp:sends:user:${userId}`;
  const sendCountKey = `otp:sends:${phone}`;
  const pipeline = redis.pipeline();
  pipeline.incr(sendCountKey);
  pipeline.expire(sendCountKey, OTP_TTL_SECONDS);
  pipeline.incr(userCountKey);
  pipeline.expire(userCountKey, OTP_TTL_SECONDS);
  await pipeline.exec();

  try {
    const client = await getBrevoClient();
    await client.transactionalSms.sendTransacSms({
      sender: process.env.BREVO_SMS_SENDER ?? 'Balo',
      recipient: phone,
      content: `Your Balo verification code is ${code}. Valid for 10 minutes.`,
      type: 'transactional',
    });

    log.info({ phone: masked, userId }, 'OTP sent');
    reply.send({ sent: true });
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
    reply.status(502).send({ error: 'brevo_rejected' });
  }
}

export async function sendOtpRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post('/phone/send-otp', { preHandler: [requireAuth] }, async (request, reply) => {
    const validated = validateRequest(request, reply);
    if (!validated) return;

    const { phone, userId, masked } = validated;
    const redis = getRedis();

    const blocked = await checkRateLimits(redis, userId, phone, masked, reply);
    if (blocked) return;

    await generateAndSendOtp(redis, phone, masked, userId, reply);
  });
}
