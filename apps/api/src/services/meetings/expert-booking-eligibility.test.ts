import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindNewWorkEligibility, mockLogWarn } = vi.hoisted(() => ({
  mockFindNewWorkEligibility: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  expertsRepository: { findNewWorkEligibility: mockFindNewWorkEligibility },
}));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mockLogWarn, error: vi.fn() }),
}));

import { BOOKABLE_CONTEXT_TYPES } from '@balo/shared/meetings';
import { checkExpertBookingEligibility } from './expert-booking-eligibility.js';

const EXPERT_ID = '66666666-6666-4666-8666-666666666666';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('checkExpertBookingEligibility', () => {
  it('passes an eligible expert and logs nothing', async () => {
    mockFindNewWorkEligibility.mockResolvedValue({ eligible: true });

    const result = await checkExpertBookingEligibility({
      contextType: 'case',
      expertProfileId: EXPERT_ID,
    });

    expect(result).toEqual({ ok: true });
    expect(mockFindNewWorkEligibility).toHaveBeenCalledWith(EXPERT_ID);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it.each(['not_found', 'owner_not_live'] as const)(
    'refuses `%s` on EVERY context and logs the reason',
    async (reason) => {
      mockFindNewWorkEligibility.mockResolvedValue({ eligible: false, reason });

      for (const contextType of BOOKABLE_CONTEXT_TYPES) {
        const result = await checkExpertBookingEligibility({
          contextType,
          expertProfileId: EXPERT_ID,
        });
        expect(result).toEqual({ ok: false, reason });
      }
      expect(mockLogWarn).toHaveBeenCalledTimes(BOOKABLE_CONTEXT_TYPES.length);
      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.objectContaining({ expertProfileId: EXPERT_ID, reason }),
        expect.any(String)
      );
    }
  );

  it.each(['not_available', 'not_approved', 'not_searchable'] as const)(
    'passes `%s` on EVERY context — only a new case is paused, and the web gate owns that',
    async (reason) => {
      mockFindNewWorkEligibility.mockResolvedValue({ eligible: false, reason });

      for (const contextType of BOOKABLE_CONTEXT_TYPES) {
        const result = await checkExpertBookingEligibility({
          contextType,
          expertProfileId: EXPERT_ID,
        });
        expect(result).toEqual({ ok: true });
      }
      expect(mockLogWarn).not.toHaveBeenCalled();
    }
  );
});
