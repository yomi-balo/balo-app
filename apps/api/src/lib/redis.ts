import { Redis } from 'ioredis';

let redis: Redis | null = null;

/**
 * Returns a shared IORedis instance configured for BullMQ.
 * `maxRetriesPerRequest: null` is required by BullMQ.
 */
export function getRedis(): Redis {
  if (redis) return redis;

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is not configured');
  }

  redis = new Redis(url, {
    maxRetriesPerRequest: null,
  });

  return redis;
}

/**
 * Creates a NEW IORedis connection for BullMQ Workers.
 * Workers use blocking commands (BRPOPLPUSH) so each worker
 * MUST have its own dedicated connection — never share the singleton.
 * Queues (producers) can share the singleton from getRedis().
 */
export function createRedisConnection(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is not configured');
  }

  return new Redis(url, {
    maxRetriesPerRequest: null,
  });
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}
