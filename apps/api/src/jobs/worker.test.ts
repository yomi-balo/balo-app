import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockStartVerifyBeneficiary = vi.fn();
const mockStartNotificationEvent = vi.fn();
const mockStartEmail = vi.fn();
const mockStartSms = vi.fn();
const mockStartInApp = vi.fn();
const mockStartAvailabilityCache = vi.fn();
const mockStartStalenessCheck = vi.fn();
const mockRegisterStalenessCron = vi.fn().mockResolvedValue(undefined);
const mockStartDeliveryReviewSweep = vi.fn();
const mockRegisterDeliveryReviewSweepCron = vi.fn().mockResolvedValue(undefined);
const mockStartOnboardingReminderSweep = vi.fn();
const mockRegisterOnboardingReminderSweepCron = vi.fn().mockResolvedValue(undefined);
const mockStartWalletDormancySweep = vi.fn();
const mockRegisterWalletDormancySweepCron = vi.fn().mockResolvedValue(undefined);
const mockStartFxDisplayRateSweep = vi.fn();
const mockRegisterFxDisplayRateSweepCron = vi.fn().mockResolvedValue(undefined);
const mockStartCreditSessionMeterSweep = vi.fn();
const mockRegisterCreditSessionMeterSweepCron = vi.fn().mockResolvedValue(undefined);
const mockStartReceivableDunningSweep = vi.fn();
const mockRegisterReceivableDunningSweepCron = vi.fn().mockResolvedValue(undefined);
const mockStartTranscriptPipeline = vi.fn();
const mockStartScheduledNotificationDispatch = vi.fn();
const mockRegisterScheduledNotificationDispatchCron = vi.fn().mockResolvedValue(undefined);
const mockStartReviewNudgeSweep = vi.fn();
const mockRegisterReviewNudgeSweepCron = vi.fn().mockResolvedValue(undefined);
const mockStartMeetingLifecycleSweep = vi.fn();
const mockRegisterMeetingLifecycleSweepCron = vi.fn().mockResolvedValue(undefined);
const mockStartCalendarHealthProbe = vi.fn();
const mockRegisterCalendarHealthProbeCron = vi.fn().mockResolvedValue(undefined);
const mockStartCalendarSubscriptionReconcile = vi.fn();
const mockStartCalendarSubscriptionMonitor = vi.fn();
const mockRegisterCalendarSubscriptionMonitorCron = vi.fn().mockResolvedValue(undefined);

vi.mock('./verify-beneficiary.js', () => ({
  startVerifyBeneficiaryWorker: () => mockStartVerifyBeneficiary(),
}));
vi.mock('./availability-cache.js', () => ({
  startAvailabilityCacheWorker: () => mockStartAvailabilityCache(),
  startStalenessCheckWorker: () => mockStartStalenessCheck(),
  registerStalenessCheckCron: () => mockRegisterStalenessCron(),
}));
vi.mock('./auto-accept-sweep.js', () => ({
  startDeliveryReviewSweepWorker: () => mockStartDeliveryReviewSweep(),
  registerDeliveryReviewSweepCron: () => mockRegisterDeliveryReviewSweepCron(),
}));
vi.mock('./onboarding-reminder-sweep.js', () => ({
  startOnboardingReminderSweepWorker: () => mockStartOnboardingReminderSweep(),
  registerOnboardingReminderSweepCron: () => mockRegisterOnboardingReminderSweepCron(),
}));
// BAL-380: mocking these is MANDATORY — otherwise the REDIS_URL-set test loads the real
// modules, which construct a Worker on a live Redis connection and hang (5s CI timeout).
vi.mock('./wallet-dormancy-sweep.js', () => ({
  startWalletDormancySweepWorker: () => mockStartWalletDormancySweep(),
  registerWalletDormancySweepCron: () => mockRegisterWalletDormancySweepCron(),
}));
vi.mock('./fx-display-rate-sweep.js', () => ({
  startFxDisplayRateSweepWorker: () => mockStartFxDisplayRateSweep(),
  registerFxDisplayRateSweepCron: () => mockRegisterFxDisplayRateSweepCron(),
}));
// BAL-378: mocking these is MANDATORY — otherwise the REDIS_URL-set test loads the real
// modules, which construct a Worker on a live Redis connection and hang (5s CI timeout).
vi.mock('./credit-session-meter-sweep.js', () => ({
  startCreditSessionMeterSweepWorker: () => mockStartCreditSessionMeterSweep(),
  registerCreditSessionMeterSweepCron: () => mockRegisterCreditSessionMeterSweepCron(),
}));
vi.mock('./receivable-dunning-sweep.js', () => ({
  startReceivableDunningSweepWorker: () => mockStartReceivableDunningSweep(),
  registerReceivableDunningSweepCron: () => mockRegisterReceivableDunningSweepCron(),
}));
// BAL-387: mocking this is MANDATORY — otherwise the REDIS_URL-set test loads the real
// module, which constructs a Worker on a live Redis connection and hangs (5s CI timeout).
vi.mock('./transcript-pipeline.js', () => ({
  startTranscriptPipelineWorker: () => mockStartTranscriptPipeline(),
}));
// BAL-420: mocking this is MANDATORY — otherwise the REDIS_URL-set test loads the real
// module, which constructs a Worker on a live Redis connection and hangs (5s CI timeout).
// Green LOCALLY whenever a dev Redis happens to be running, which is exactly how it slipped
// through in BAL-378, BAL-380 and BAL-387.
vi.mock('./scheduled-notification-dispatch.js', () => ({
  startScheduledNotificationDispatchWorker: () => mockStartScheduledNotificationDispatch(),
  registerScheduledNotificationDispatchCron: () => mockRegisterScheduledNotificationDispatchCron(),
}));
// BAL-390: mocking these is MANDATORY — otherwise the REDIS_URL-set test loads the real
// module, which constructs a Worker on a live Redis connection and hangs (5s CI timeout).
// It stays GREEN LOCALLY if a dev Redis happens to be running, so it must land in the
// same commit as the `worker.ts` registration.
vi.mock('./review-nudge-sweep.js', () => ({
  startReviewNudgeSweepWorker: () => mockStartReviewNudgeSweep(),
  registerReviewNudgeSweepCron: () => mockRegisterReviewNudgeSweepCron(),
}));
// BAL-134: mocking these is MANDATORY — otherwise the REDIS_URL-set test loads the real module,
// which constructs a Worker on a live Redis connection and HANGS at the 5s CI timeout. It stays
// GREEN LOCALLY whenever a dev Redis happens to be running, which is exactly how it slipped
// through in BAL-378, BAL-380, BAL-387, BAL-420 and BAL-390 — five tickets in a row. It must
// land in the SAME COMMIT as the `worker.ts` registration.
vi.mock('./meeting-lifecycle-sweep.js', () => ({
  startMeetingLifecycleSweepWorker: () => mockStartMeetingLifecycleSweep(),
  registerMeetingLifecycleSweepCron: () => mockRegisterMeetingLifecycleSweepCron(),
}));
// BAL-396: mocking these is MANDATORY — otherwise the REDIS_URL-set test loads the real module,
// which constructs a Worker on a live Redis connection and HANGS at the 5s CI timeout. It stays
// GREEN LOCALLY whenever a dev Redis happens to be running, which is exactly how it slipped
// through in BAL-378, BAL-380, BAL-387, BAL-420, BAL-390 and BAL-134 — six tickets in a row. It
// must land in the SAME COMMIT as the `worker.ts` registration.
vi.mock('./calendar-health-probe.js', () => ({
  startCalendarHealthProbeWorker: () => mockStartCalendarHealthProbe(),
  registerCalendarHealthProbeCron: () => mockRegisterCalendarHealthProbeCron(),
}));
// BAL-468: mocking these is MANDATORY — otherwise the REDIS_URL-set test loads the real
// modules, which construct a Worker on a live Redis connection and HANGS at the 5s CI timeout.
// It stays GREEN LOCALLY whenever a dev Redis happens to be running, which is exactly how it
// slipped through in every ticket named in the comments above. Must land in the SAME COMMIT as
// the `worker.ts` registration.
vi.mock('./calendar-subscription-reconcile.js', () => ({
  startCalendarSubscriptionReconcileWorker: () => mockStartCalendarSubscriptionReconcile(),
}));
vi.mock('./calendar-subscription-monitor.js', () => ({
  startCalendarSubscriptionMonitorWorker: () => mockStartCalendarSubscriptionMonitor(),
  registerCalendarSubscriptionMonitorCron: () => mockRegisterCalendarSubscriptionMonitorCron(),
}));
vi.mock('../notifications/engine/worker.js', () => ({
  startNotificationEventWorker: () => mockStartNotificationEvent(),
}));
vi.mock('../notifications/channels/email.adapter.js', () => ({
  startEmailWorker: () => mockStartEmail(),
}));
vi.mock('../notifications/channels/sms.adapter.js', () => ({
  startSmsWorker: () => mockStartSms(),
}));
vi.mock('../notifications/channels/in-app.adapter.js', () => ({
  startInAppWorker: () => mockStartInApp(),
}));

import { startWorkers } from './worker.js';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('startWorkers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips workers when REDIS_URL is not set', async () => {
    delete process.env.REDIS_URL;
    const logger = { info: vi.fn() };

    await startWorkers(logger);

    expect(mockStartVerifyBeneficiary).not.toHaveBeenCalled();
    expect(mockStartInApp).not.toHaveBeenCalled();
    expect(mockStartAvailabilityCache).not.toHaveBeenCalled();
    expect(mockStartScheduledNotificationDispatch).not.toHaveBeenCalled();
    expect(mockRegisterScheduledNotificationDispatchCron).not.toHaveBeenCalled();
    expect(mockStartCalendarHealthProbe).not.toHaveBeenCalled();
    expect(mockRegisterCalendarHealthProbeCron).not.toHaveBeenCalled();
    expect(mockStartCalendarSubscriptionReconcile).not.toHaveBeenCalled();
    expect(mockStartCalendarSubscriptionMonitor).not.toHaveBeenCalled();
    expect(mockRegisterCalendarSubscriptionMonitorCron).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('REDIS_URL not set — BullMQ workers not started');
  });

  it('starts all workers when REDIS_URL is set', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const logger = { info: vi.fn() };

    await startWorkers(logger);

    expect(mockStartVerifyBeneficiary).toHaveBeenCalled();
    expect(mockStartNotificationEvent).toHaveBeenCalled();
    expect(mockStartEmail).toHaveBeenCalled();
    expect(mockStartSms).toHaveBeenCalled();
    expect(mockStartInApp).toHaveBeenCalled();
    expect(mockStartAvailabilityCache).toHaveBeenCalled();
    expect(mockStartStalenessCheck).toHaveBeenCalled();
    expect(mockRegisterStalenessCron).toHaveBeenCalled();
    expect(mockStartDeliveryReviewSweep).toHaveBeenCalled();
    expect(mockRegisterDeliveryReviewSweepCron).toHaveBeenCalled();
    expect(mockStartOnboardingReminderSweep).toHaveBeenCalled();
    expect(mockRegisterOnboardingReminderSweepCron).toHaveBeenCalled();
    expect(mockStartWalletDormancySweep).toHaveBeenCalled();
    expect(mockRegisterWalletDormancySweepCron).toHaveBeenCalled();
    expect(mockStartFxDisplayRateSweep).toHaveBeenCalled();
    expect(mockRegisterFxDisplayRateSweepCron).toHaveBeenCalled();
    expect(mockStartCreditSessionMeterSweep).toHaveBeenCalled();
    expect(mockRegisterCreditSessionMeterSweepCron).toHaveBeenCalled();
    expect(mockStartReceivableDunningSweep).toHaveBeenCalled();
    expect(mockRegisterReceivableDunningSweepCron).toHaveBeenCalled();
    expect(mockStartTranscriptPipeline).toHaveBeenCalled();
    expect(mockStartScheduledNotificationDispatch).toHaveBeenCalled();
    expect(mockRegisterScheduledNotificationDispatchCron).toHaveBeenCalled();
    expect(mockStartReviewNudgeSweep).toHaveBeenCalled();
    expect(mockRegisterReviewNudgeSweepCron).toHaveBeenCalled();
    expect(mockStartMeetingLifecycleSweep).toHaveBeenCalled();
    expect(mockRegisterMeetingLifecycleSweepCron).toHaveBeenCalled();
    expect(mockStartCalendarHealthProbe).toHaveBeenCalled();
    expect(mockRegisterCalendarHealthProbeCron).toHaveBeenCalled();
    expect(mockStartCalendarSubscriptionReconcile).toHaveBeenCalled();
    expect(mockStartCalendarSubscriptionMonitor).toHaveBeenCalled();
    expect(mockRegisterCalendarSubscriptionMonitorCron).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('BullMQ workers started');

    delete process.env.REDIS_URL;
  });

  it('works without a logger', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';

    await expect(startWorkers()).resolves.not.toThrow();

    expect(mockStartInApp).toHaveBeenCalled();

    delete process.env.REDIS_URL;
  });
});
