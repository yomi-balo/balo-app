import type { FastifyInstance } from 'fastify';
import { sendOtpRoute } from './send-otp.js';
import { verifyOtpRoute } from './verify-otp.js';

export async function phoneRoutes(fastify: FastifyInstance): Promise<void> {
  await fastify.register(sendOtpRoute);
  await fastify.register(verifyOtpRoute);
}
