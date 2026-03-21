import { startVerifyBeneficiaryWorker } from './verify-beneficiary.js';
import { startNotificationEventWorker } from '../notifications/engine/worker.js';
import { startEmailWorker } from '../notifications/channels/email.adapter.js';

/**
 * Start all BullMQ workers.
 * Guards on REDIS_URL — if not set, workers are skipped (local dev without Redis).
 */
export function startWorkers(logger?: { info: (msg: string) => void }): void {
  if (!process.env.REDIS_URL) {
    logger?.info('REDIS_URL not set — BullMQ workers not started');
    return;
  }

  startVerifyBeneficiaryWorker();
  startNotificationEventWorker();
  startEmailWorker();
  logger?.info('BullMQ workers started');
}
