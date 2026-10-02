import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  mockMeterSessionToNow,
  mockFindWallet,
  mockPublishLowBalance,
  mockPublishGraceEntered,
  mockPublishNearWrap,
  mockTrackCeilingHit,
  mockLogError,
  mockLogWarn,
} = vi.hoisted(() => ({
  mockMeterSessionToNow: vi.fn(),
  mockFindWallet: vi.fn(),
  mockPublishLowBalance: vi.fn(),
  mockPublishGraceEntered: vi.fn(),
  mockPublishNearWrap: vi.fn(),
  mockTrackCeilingHit: vi.fn(),
  mockLogError: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), error: mockLogError, warn: mockLogWarn }),
}));
vi.mock('@balo/db', () => ({
  creditSessionsRepository: { meterSessionToNow: mockMeterSessionToNow },
  creditWalletsRepository: { findById: mockFindWallet },
}));
vi.mock('./notify.js', () => ({
  publishLowBalance: mockPublishLowBalance,
  publishGraceEntered: mockPublishGraceEntered,
  publishNearWrap: mockPublishNearWrap,
  trackCeilingHit: mockTrackCeilingHit,
}));

import { driveSession } from './meter-driver.js';

const SESSION = { id: 'session_1', walletId: 'wallet_1', companyId: 'company_1' };
const NOW = new Date('2026-07-16T12:00:00.000Z');

function meterResult(transitions: Record<string, boolean>) {
  return { session: SESSION, transitions, ticksPosted: 1 };
}

describe('driveSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindWallet.mockResolvedValue({ balanceMinor: -2000 });
  });

  it('publishes nothing (and reads no wallet) when no transitions cross', async () => {
    mockMeterSessionToNow.mockResolvedValue(meterResult({}));
    await driveSession('session_1', NOW);
    expect(mockFindWallet).not.toHaveBeenCalled();
    expect(mockPublishLowBalance).not.toHaveBeenCalled();
    expect(mockPublishGraceEntered).not.toHaveBeenCalled();
    expect(mockPublishNearWrap).not.toHaveBeenCalled();
    expect(mockTrackCeilingHit).not.toHaveBeenCalled();
  });

  it('publishes the low-balance notice on a low transition', async () => {
    mockMeterSessionToNow.mockResolvedValue(meterResult({ low: true }));
    await driveSession('session_1', NOW);
    expect(mockPublishLowBalance).toHaveBeenCalledWith(SESSION, -2000);
  });

  it('publishes grace-entered on a graceEntered transition', async () => {
    mockMeterSessionToNow.mockResolvedValue(meterResult({ graceEntered: true }));
    await driveSession('session_1', NOW);
    expect(mockPublishGraceEntered).toHaveBeenCalledWith(SESSION, -2000, NOW);
  });

  it('publishes near-wrap on a nearWrap transition', async () => {
    mockMeterSessionToNow.mockResolvedValue(meterResult({ nearWrap: true }));
    await driveSession('session_1', NOW);
    expect(mockPublishNearWrap).toHaveBeenCalledWith(SESSION, NOW);
  });

  it('tracks the ceiling hit (analytics only) on a ceilingHit transition', async () => {
    mockMeterSessionToNow.mockResolvedValue(meterResult({ wrapped: true, ceilingHit: true }));
    await driveSession('session_1', NOW);
    expect(mockTrackCeilingHit).toHaveBeenCalledWith(SESSION, -2000);
  });

  describe('cap reached (maxSessionMinutesReached)', () => {
    function capResult(
      durationSource: string,
      withheldTicks: number,
      pastScheduledEnd: boolean | null
    ) {
      return {
        session: { ...SESSION, durationSource, lastTickSeq: 240 },
        transitions: { maxSessionMinutesReached: { withheldTicks, pastScheduledEnd } },
        ticksPosted: 1,
      };
    }

    it.each([
      ['presence past its scheduled end', 'presence', 0, true],
      ['presence with an unreadable meeting', 'presence', 0, null],
      ['live_capture backfilled 60 ticks late', 'live_capture', 60, null],
    ] as const)('%s logs an error once and no warning', async (_label, source, withheld, past) => {
      mockMeterSessionToNow.mockResolvedValue(capResult(source, withheld, past));
      await driveSession('session_1', NOW);
      expect(mockLogError).toHaveBeenCalledTimes(1);
      expect(mockLogError).toHaveBeenCalledWith(
        {
          sessionId: 'session_1',
          durationSource: source,
          withheldTicks: withheld,
          pastScheduledEnd: past,
        },
        expect.stringContaining('MAX_SESSION_MINUTES')
      );
      expect(mockLogWarn).not.toHaveBeenCalled();
    });

    it.each([
      ['presence within its booking', 'presence', 0, false],
      ['live_capture one sweep late', 'live_capture', 1, null],
    ] as const)('%s logs a warning once and no error', async (_label, source, withheld, past) => {
      mockMeterSessionToNow.mockResolvedValue(capResult(source, withheld, past));
      await driveSession('session_1', NOW);
      expect(mockLogWarn).toHaveBeenCalledTimes(1);
      expect(mockLogWarn).toHaveBeenCalledWith(
        {
          sessionId: 'session_1',
          durationSource: source,
          withheldTicks: withheld,
          pastScheduledEnd: past,
        },
        expect.stringContaining('billable cap')
      );
      expect(mockLogError).not.toHaveBeenCalled();
    });

    it('publishes nothing on a cap-only run', async () => {
      mockMeterSessionToNow.mockResolvedValue(capResult('presence', 0, true));
      await driveSession('session_1', NOW);
      expect(mockFindWallet).not.toHaveBeenCalled();
      expect(mockPublishLowBalance).not.toHaveBeenCalled();
      expect(mockTrackCeilingHit).not.toHaveBeenCalled();
    });

    it('logs neither when the flag is absent', async () => {
      mockMeterSessionToNow.mockResolvedValue(meterResult({ low: true }));
      await driveSession('session_1', NOW);
      expect(mockLogError).not.toHaveBeenCalled();
      expect(mockLogWarn).not.toHaveBeenCalled();
    });
  });

  it('returns the repo meter result', async () => {
    const result = meterResult({ low: true });
    mockMeterSessionToNow.mockResolvedValue(result);
    await expect(driveSession('session_1', NOW)).resolves.toBe(result);
  });
});
