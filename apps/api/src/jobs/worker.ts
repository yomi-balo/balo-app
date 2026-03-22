import { startVerifyBeneficiaryWorker } from './verify-beneficiary.js';
import { startNotificationEventWorker } from '../notifications/engine/worker.js';
import { startEmailWorker } from '../notifications/channels/email.adapter.js';
import { startSmsWorker } from '../notifications/channels/sms.adapter.js';
import { startInAppWorker } from '../notifications/channels/in-app.adapter.js';

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
  startSmsWorker();
  startInAppWorker();
  logger?.info('BullMQ workers started');
}
