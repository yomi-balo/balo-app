import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockListRules, mockListConfirmedInRange, mockListUpcoming } = vi.hoisted(() => ({
  mockListRules: vi.fn(),
  mockListConfirmedInRange: vi.fn(),
  mockListUpcoming: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  availabilityRulesRepository: { listByExpertProfileId: mockListRules },
  consultationsRepository: { listConfirmedInRange: mockListConfirmedInRange },
  availabilityOverridesRepository: { listUpcoming: mockListUpcoming },
}));

import { loadResolverInputs } from './load-resolver-inputs.js';
import { vendorBusyProvider, VendorBusyUnavailableError } from './vendor-busy.js';

const EXPERT_PROFILE_ID = '66666666-6666-4666-8666-666666666666';
const FROM = new Date('2026-09-06T00:00:00.000Z');
const TO = new Date('2026-09-08T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
  mockListRules.mockResolvedValue([]);
  mockListConfirmedInRange.mockResolvedValue([]);
  mockListUpcoming.mockResolvedValue([]);
});

describe('loadResolverInputs', () => {
  it('runs the four reads concurrently and returns their values', async () => {
    const rules = [{ dayOfWeek: 1, startTime: '09:00:00', endTime: '17:00:00' }];
    const consultations = [
      { startAt: new Date('2026-09-07T10:00:00Z'), endAt: new Date('2026-09-07T11:00:00Z') },
    ];
    const overrides = [{ startDate: '2026-09-10', endDate: '2026-09-10' }];
    const busy = [
      { startAt: new Date('2026-09-07T13:00:00Z'), endAt: new Date('2026-09-07T14:00:00Z') },
    ];

    mockListRules.mockResolvedValue(rules);
    mockListConfirmedInRange.mockResolvedValue(consultations);
    mockListUpcoming.mockResolvedValue(overrides);
    const spy = vi.spyOn(vendorBusyProvider, 'listBusyBlocks').mockResolvedValue(busy);

    const result = await loadResolverInputs(EXPERT_PROFILE_ID, FROM, TO);

    expect(result.rules).toEqual(rules);
    expect(result.baloConsultations).toEqual(consultations);
    expect(result.overrides).toEqual(overrides);
    expect(result.busyOutcome).toEqual({ ok: true, value: busy });
    expect(spy).toHaveBeenCalledWith(EXPERT_PROFILE_ID, FROM, TO);
  });

  it('tags a VendorBusyUnavailableError into { ok: false } rather than throwing', async () => {
    const err = new VendorBusyUnavailableError(EXPERT_PROFILE_ID, 'unreadable connection');
    vi.spyOn(vendorBusyProvider, 'listBusyBlocks').mockRejectedValue(err);

    const result = await loadResolverInputs(EXPERT_PROFILE_ID, FROM, TO);

    expect(result.busyOutcome).toEqual({ ok: false, error: err });
  });

  it('tags a non-vendor rejection too, so callers decide whether to rethrow', async () => {
    const dbErr = new Error('connection reset');
    vi.spyOn(vendorBusyProvider, 'listBusyBlocks').mockRejectedValue(dbErr);

    const result = await loadResolverInputs(EXPERT_PROFILE_ID, FROM, TO);

    expect(result.busyOutcome).toEqual({ ok: false, error: dbErr });
  });

  it('busyBlocksOverride short-circuits the vendor port entirely (seed/test-only)', async () => {
    const override = [
      { startAt: new Date('2026-09-07T08:00:00Z'), endAt: new Date('2026-09-07T09:00:00Z') },
    ];
    const spy = vi.spyOn(vendorBusyProvider, 'listBusyBlocks');

    const result = await loadResolverInputs(EXPERT_PROFILE_ID, FROM, TO, override);

    expect(spy).not.toHaveBeenCalled();
    expect(result.busyOutcome).toEqual({ ok: true, value: override });
  });
});
