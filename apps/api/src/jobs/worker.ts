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
    { startAvailabilityCacheWorker, startStalenessCheckWorker, registerStalenessCheckCron },
    { startDeliveryReviewSweepWorker, registerDeliveryReviewSweepCron },
    { startOnboardingReminderSweepWorker, registerOnboardingReminderSweepCron },
  ] = await Promise.all([
    import('./verify-beneficiary.js'),
    import('../notifications/engine/worker.js'),
    import('../notifications/channels/email.adapter.js'),
    import('../notifications/channels/sms.adapter.js'),
    import('../notifications/channels/in-app.adapter.js'),
    import('./availability-cache.js'),
    import('./auto-accept-sweep.js'),
    import('./onboarding-reminder-sweep.js'),
  ]);

  startVerifyBeneficiaryWorker();
  startNotificationEventWorker();
  startEmailWorker();
  startSmsWorker();
  startInAppWorker();
  startAvailabilityCacheWorker();
  startStalenessCheckWorker();
  await registerStalenessCheckCron();
  // BAL-338 (D7): auto-accept + T-2 review reminder sweep.
  startDeliveryReviewSweepWorker();
  await registerDeliveryReviewSweepCron();
  // BAL-374: onboarding-completion reminder sweep (+24h / +72h / +7d).
  startOnboardingReminderSweepWorker();
  await registerOnboardingReminderSweepCron();
  logger?.info('BullMQ workers started');
}
