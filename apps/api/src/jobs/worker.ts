import { startVerifyBeneficiaryWorker } from './verify-beneficiary.js';

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
  logger?.info('BullMQ workers started');
}
