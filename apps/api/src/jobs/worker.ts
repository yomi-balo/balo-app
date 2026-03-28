/**
 * Start all BullMQ workers.
 * Guards on REDIS_URL — if not set, workers are skipped (local dev without Redis).
 * Uses dynamic imports to avoid ESM/CJS interop issues with @balo/shared at module load.
 */
export async function startWorkers(logger?: { info: (msg: string) => void }): Promise<void> {
  if (!process.env.REDIS_URL) {
    logger?.info('REDIS_URL not set — BullMQ workers not started');
    return;
  }

  const [
    { startVerifyBeneficiaryWorker },
    { startNotificationEventWorker },
    { startEmailWorker },
    { startSmsWorker },
    { startInAppWorker },
  ] = await Promise.all([
    import('./verify-beneficiary.js'),
    import('../notifications/engine/worker.js'),
    import('../notifications/channels/email.adapter.js'),
    import('../notifications/channels/sms.adapter.js'),
    import('../notifications/channels/in-app.adapter.js'),
  ]);

  startVerifyBeneficiaryWorker();
  startNotificationEventWorker();
  startEmailWorker();
  startSmsWorker();
  startInAppWorker();
  logger?.info('BullMQ workers started');
}
