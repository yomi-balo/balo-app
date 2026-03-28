import type { FastifyInstance } from 'fastify';
import { createRequire } from 'node:module';
import { timingSafeEqual } from 'node:crypto';
import { getRedis } from '../../lib/redis.js';
import { requireAuth } from '../../lib/require-auth.js';
import { verifyOtpBodySchema } from './schema.js';

// @balo/shared is CJS; static ESM import fails under tsx — use createRequire
const { createLogger } = createRequire(import.meta.url)('@balo/shared/logging');
const log = createLogger('phone-verify-otp');

/** Max wrong attempts before lockout. */
const MAX_ATTEMPTS = 3;

/** Mask phone number for logging — show last 4 digits only. */
function maskPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return '****' + phone.slice(-4);
}

export async function verifyOtpRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post('/phone/verify-otp', { preHandler: [requireAuth] }, async (request, reply) => {
    const parsed = verifyOtpBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'invalid_input',
        details: parsed.error.issues.map((i: { message: string }) => i.message),
      });
    }

    const { phone, code } = parsed.data;
    const userId = request.userId!;
    const masked = maskPhone(phone);
    const redis = getRedis();
    const otpKey = `otp:${phone}`;

    // 1. Get stored OTP record
    const stored = await redis.get(otpKey);
    if (!stored) {
      log.warn({ phone: masked }, 'OTP expired or not found');
      return reply.status(400).send({ error: 'code_expired' });
    }

    const record = JSON.parse(stored) as { code: string; attempts: number };

    // 2. Check if already locked out
    if (record.attempts >= MAX_ATTEMPTS) {
      return reply.status(400).send({ error: 'locked_out' });
    }

    // 3. Wrong code — increment attempts (constant-time comparison)
    const codeMatch = timingSafeEqual(Buffer.from(code), Buffer.from(record.code));
    if (!codeMatch) {
      const newAttempts = record.attempts + 1;
      const attemptsRemaining = MAX_ATTEMPTS - newAttempts;

      if (attemptsRemaining <= 0) {
        // Delete the OTP key — locked out
        await redis.del(otpKey);
        log.warn({ userId, phone: masked, attemptsRemaining: 0 }, 'OTP locked out');
        return reply.status(400).send({ error: 'locked_out' });
      }

      // Update attempts count in Redis (preserve existing TTL with KEEPTTL)
      await redis.set(
        otpKey,
        JSON.stringify({ code: record.code, attempts: newAttempts }),
        'KEEPTTL'
      );

      log.warn({ userId, phone: masked, attemptsRemaining }, 'OTP wrong code');

      if (attemptsRemaining === 1) {
        return reply.status(400).send({ error: 'final_attempt', attemptsRemaining: 1 });
      }

      return reply.status(400).send({ error: 'wrong_code', attemptsRemaining });
    }

    // 4. Code matches — success
    // Delete OTP keys
    const sendCountKey = `otp:sends:${phone}`;
    await redis.del(otpKey, sendCountKey);

    // Write to DB
    const { usersRepository } = createRequire(import.meta.url)('@balo/db');
    await usersRepository.setPhoneVerified(userId, phone, new Date());

    log.info({ userId, phone: masked }, 'Phone verified');
    return reply.send({ verified: true });
  });
}
