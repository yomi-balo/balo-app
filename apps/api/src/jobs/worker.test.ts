import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockStartVerifyBeneficiary = vi.fn();
const mockStartNotificationEvent = vi.fn();
const mockStartEmail = vi.fn();
const mockStartSms = vi.fn();
const mockStartInApp = vi.fn();

vi.mock('./verify-beneficiary.js', () => ({
  startVerifyBeneficiaryWorker: () => mockStartVerifyBeneficiary(),
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

  it('skips workers when REDIS_URL is not set', () => {
    delete process.env.REDIS_URL;
    const logger = { info: vi.fn() };

    startWorkers(logger);

    expect(mockStartVerifyBeneficiary).not.toHaveBeenCalled();
    expect(mockStartInApp).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('REDIS_URL not set — BullMQ workers not started');
  });

  it('starts all workers when REDIS_URL is set', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const logger = { info: vi.fn() };

    startWorkers(logger);

    expect(mockStartVerifyBeneficiary).toHaveBeenCalled();
    expect(mockStartNotificationEvent).toHaveBeenCalled();
    expect(mockStartEmail).toHaveBeenCalled();
    expect(mockStartSms).toHaveBeenCalled();
    expect(mockStartInApp).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('BullMQ workers started');

    delete process.env.REDIS_URL;
  });

  it('works without a logger', () => {
    process.env.REDIS_URL = 'redis://localhost:6379';

    expect(() => startWorkers()).not.toThrow();

    expect(mockStartInApp).toHaveBeenCalled();

    delete process.env.REDIS_URL;
  });
});
