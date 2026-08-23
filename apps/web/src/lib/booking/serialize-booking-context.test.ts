import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { serializeBookingContext } from './serialize-booking-context';
import type { BookingContext } from './load-booking-context';

const EXPERT_DISPLAY = { firstName: 'Dana', partyLabel: 'Dana Okoro' };

// M7 — the only `Date` → ISO boundary in the booking feature; a bug here would silently
// corrupt every case card's dates on the client.
describe('serializeBookingContext', () => {
  it('passes onboarding_required through unchanged', () => {
    const context: BookingContext = { arm: 'onboarding_required' };
    expect(serializeBookingContext(context)).toEqual({ arm: 'onboarding_required' });
  });

  it('passes company_read_failed through unchanged', () => {
    const context: BookingContext = { arm: 'company_read_failed' };
    expect(serializeBookingContext(context)).toEqual({ arm: 'company_read_failed' });
  });

  it('keeps companies but DROPS the arm-carried expert field on choose_company', () => {
    const context: BookingContext = {
      arm: 'choose_company',
      companies: [{ id: 'company-1', name: 'Northwind', logoUrl: null }],
      expert: EXPERT_DISPLAY,
    };
    const result = serializeBookingContext(context);
    expect(result).toEqual({
      arm: 'choose_company',
      companies: [{ id: 'company-1', name: 'Northwind', logoUrl: null }],
    });
    expect('expert' in result).toBe(false);
  });

  it('converts single_company Date fields to ISO strings and drops expert', () => {
    const context: BookingContext = {
      arm: 'single_company',
      company: { id: 'company-1', name: 'Northwind', logoUrl: null },
      resolvedCaseCount: 3,
      openCases: [
        {
          engagementId: 'engagement-1',
          title: 'Flow interview loop',
          createdAt: new Date('2026-05-01T00:00:00.000Z'),
          lastActivityAt: new Date('2026-06-01T00:00:00.000Z'),
          consultationCount: 2,
        },
      ],
      expert: EXPERT_DISPLAY,
    };
    const result = serializeBookingContext(context);
    expect(result).toEqual({
      arm: 'single_company',
      company: { id: 'company-1', name: 'Northwind', logoUrl: null },
      resolvedCaseCount: 3,
      openCases: [
        {
          engagementId: 'engagement-1',
          title: 'Flow interview loop',
          createdAt: '2026-05-01T00:00:00.000Z',
          lastActivityAt: '2026-06-01T00:00:00.000Z',
          consultationCount: 2,
        },
      ],
    });
    expect('expert' in result).toBe(false);
  });

  it('serializes an EMPTY single_company openCases array to an empty array, not undefined', () => {
    const context: BookingContext = {
      arm: 'single_company',
      company: { id: 'company-1', name: 'Northwind', logoUrl: null },
      resolvedCaseCount: 0,
      openCases: [],
      expert: EXPERT_DISPLAY,
    };
    const result = serializeBookingContext(context);
    expect(result).toMatchObject({ openCases: [] });
  });
});
