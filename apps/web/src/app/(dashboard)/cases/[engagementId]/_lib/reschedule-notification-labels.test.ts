import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockFindCompany = vi.fn();
const mockFindProfile = vi.fn();
const mockFindUser = vi.fn();
const mockFindAgency = vi.fn();

vi.mock('@balo/db', () => ({
  companiesRepository: { findNameById: (...a: unknown[]) => mockFindCompany(...a) },
  expertsRepository: { findDisplayProfileById: (...a: unknown[]) => mockFindProfile(...a) },
  usersRepository: { findDisplayById: (...a: unknown[]) => mockFindUser(...a) },
  agenciesRepository: { getSummaryById: (...a: unknown[]) => mockFindAgency(...a) },
}));

import { resolveNotificationLabels } from './reschedule-notification-labels';

const COMPANY_ID = 'a0000000-0000-4000-8000-000000000004';
const EXPERT_PROFILE_ID = 'a0000000-0000-4000-8000-000000000005';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveNotificationLabels', () => {
  it('resolves an AGENCY expert with the agency name on both party and person labels', async () => {
    mockFindCompany.mockResolvedValue({ name: 'Northwind Industrial' });
    mockFindProfile.mockResolvedValue({ userId: 'u-1', type: 'agency', agencyId: 'ag-1' });
    mockFindUser.mockResolvedValue({ firstName: 'Dana', lastName: 'Reyes' });
    mockFindAgency.mockResolvedValue({ name: 'CloudPeak' });

    const result = await resolveNotificationLabels(COMPANY_ID, EXPERT_PROFILE_ID);

    expect(result).toEqual({
      clientCompanyName: 'Northwind Industrial',
      expertPartyLabel: 'CloudPeak',
      expertPersonLabel: 'Dana Reyes @ CloudPeak',
    });
  });

  it('resolves an INDEPENDENT expert with their own name on both labels — no "@ self"', async () => {
    mockFindCompany.mockResolvedValue({ name: 'Northwind Industrial' });
    mockFindProfile.mockResolvedValue({ userId: 'u-1', type: 'freelancer', agencyId: null });
    mockFindUser.mockResolvedValue({ firstName: 'Amara', lastName: 'Okafor' });

    const result = await resolveNotificationLabels(COMPANY_ID, EXPERT_PROFILE_ID);

    expect(result.expertPartyLabel).toBe('Amara Okafor');
    expect(result.expertPersonLabel).toBe('Amara Okafor');
    expect(result.expertPersonLabel).not.toContain('@');
  });

  it('degrades to neutral fallbacks when the company/profile rows are missing', async () => {
    mockFindCompany.mockResolvedValue(undefined);
    mockFindProfile.mockResolvedValue(undefined);

    const result = await resolveNotificationLabels(COMPANY_ID, EXPERT_PROFILE_ID);

    expect(result.clientCompanyName).toBe('your company');
    expect(result.expertPartyLabel).toBeTruthy();
    expect(result.expertPersonLabel).toBeTruthy();
  });
});
