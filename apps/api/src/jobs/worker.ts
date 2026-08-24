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
    { startWalletDormancySweepWorker, registerWalletDormancySweepCron },
    { startFxDisplayRateSweepWorker, registerFxDisplayRateSweepCron },
    { startCreditSessionMeterSweepWorker, registerCreditSessionMeterSweepCron },
    { startReceivableDunningSweepWorker, registerReceivableDunningSweepCron },
    { startTranscriptPipelineWorker },
    { startScheduledNotificationDispatchWorker, registerScheduledNotificationDispatchCron },
    { startReviewNudgeSweepWorker, registerReviewNudgeSweepCron },
    { startMeetingLifecycleSweepWorker, registerMeetingLifecycleSweepCron },
    { startCalendarHealthProbeWorker, registerCalendarHealthProbeCron },
    { startCalendarSubscriptionReconcileWorker },
    { startCalendarSubscriptionMonitorWorker, registerCalendarSubscriptionMonitorCron },
    { startMeetingCalendarAmendWorker },
  ] = await Promise.all([
    import('./verify-beneficiary.js'),
    import('../notifications/engine/worker.js'),
    import('../notifications/channels/email.adapter.js'),
    import('../notifications/channels/sms.adapter.js'),
    import('../notifications/channels/in-app.adapter.js'),
    import('./availability-cache.js'),
    import('./auto-accept-sweep.js'),
    import('./onboarding-reminder-sweep.js'),
    import('./wallet-dormancy-sweep.js'),
    import('./fx-display-rate-sweep.js'),
    import('./credit-session-meter-sweep.js'),
    import('./receivable-dunning-sweep.js'),
    import('./transcript-pipeline.js'),
    import('./scheduled-notification-dispatch.js'),
    import('./review-nudge-sweep.js'),
    import('./meeting-lifecycle-sweep.js'),
    import('./calendar-health-probe.js'),
    import('./calendar-subscription-reconcile.js'),
    import('./calendar-subscription-monitor.js'),
    import('./meeting-calendar-amend.js'),
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
  // BAL-380 (ADR-1040 Lane 3): daily wallet dormancy/expiry sweep + display-FX sweep.
  startWalletDormancySweepWorker();
  await registerWalletDormancySweepCron();
  startFxDisplayRateSweepWorker();
  await registerFxDisplayRateSweepCron();
  // BAL-378 (ADR-1040 Lane 2): per-minute credit-session meter reaper + daily receivable dunning.
  startCreditSessionMeterSweepWorker();
  await registerCreditSessionMeterSweepCron();
  startReceivableDunningSweepWorker();
  await registerReceivableDunningSweepCron();
  // BAL-387 (ADR-1013): the transcript pipeline worker (event-triggered — no cron).
  startTranscriptPipelineWorker();
  // BAL-420 (ADR-1047): the per-minute scheduled-notification dispatch tick. Postgres is
  // the clock — this cron is only the ticker, and there are no delayed BullMQ jobs anywhere.
  startScheduledNotificationDispatchWorker();
  await registerScheduledNotificationDispatchCron();
  // BAL-390: the star-rating nudge sweep (+24h / +7d off accepted_at | closed_at).
  // ⚠ HOURLY, AND NOT A FREE KNOB — the candidate band width in `@balo/shared/reviews`
  // (REVIEW_NUDGE_WINDOW_MS) is COUPLED to this cadence, and a unit test asserts they
  // agree. Read that constant's warning before changing either.
  startReviewNudgeSweepWorker();
  await registerReviewNudgeSweepCron();
  // BAL-134 (ADR-1049): the per-minute meeting lifecycle sweep — Daily presence reconciliation,
  // the four system terminal rules, and the two absence promises.
  // ⚠ PER-MINUTE IS NOT A FREE KNOB: it is what bounds the dropped-`participant.left` over-bill
  // to ONE TICK. Slowing this cadence widens a MONEY error. See the job's docblock.
  startMeetingLifecycleSweepWorker();
  await registerMeetingLifecycleSweepCron();
  // BAL-396 (§9, ADR-1021 amendment 18 Aug 2026): the 15-minute Apiroc calendar credential
  // health probe — the platform's only PROACTIVE breakage signal (a dead credential is
  // detected here, before any booking attempt touches it).
  startCalendarHealthProbeWorker();
  await registerCalendarHealthProbeCron();
  // BAL-468 — the subscription-reconcile worker (trigger-driven, no cron of its own) and the
  // daily 07:00 UTC expiry monitor.
  startCalendarSubscriptionReconcileWorker();
  startCalendarSubscriptionMonitorWorker();
  await registerCalendarSubscriptionMonitorCron();
  // BAL-409 — the retrying, converging Apiroc calendar amend for a client-initiated reschedule.
  // Trigger-driven (enqueued from `rescheduleMeeting`'s post-commit block), no cron of its own.
  startMeetingCalendarAmendWorker();
  logger?.info('BullMQ workers started');
}
