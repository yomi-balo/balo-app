import { Queue, type QueueOptions } from 'bullmq';
import { getRedis } from './redis.js';

const queues = new Map<string, Queue>();

const DEFAULT_JOB_OPTIONS: QueueOptions['defaultJobOptions'] = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
};

/**
 * Returns a shared BullMQ Queue for the given name.
 * Creates it on first call and caches for subsequent use.
 */
export function getQueue(name: string): Queue {
  const existing = queues.get(name);
  if (existing) return existing;

  const queue = new Queue(name, {
    connection: getRedis(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  queues.set(name, queue);
  return queue;
}
