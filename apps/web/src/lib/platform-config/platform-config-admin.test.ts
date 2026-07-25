import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockGet = vi.fn();
vi.mock('@balo/db', () => ({
  platformConfigRepository: { get: () => mockGet() },
}));

import { loadPlatformConfigAdmin } from './platform-config-admin';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadPlatformConfigAdmin', () => {
  it('derives the DTO from the seeded config row', async () => {
    mockGet.mockResolvedValue({
      id: 1,
      minConsultationMinutes: 30,
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedBy: 'admin-1',
    });

    const dto = await loadPlatformConfigAdmin();

    expect(dto).toEqual({ minConsultationMinutes: 30, billingFloorMinutes: 15 });
  });

  it('falls back to the billing floor when the row is somehow absent', async () => {
    mockGet.mockResolvedValue(undefined);

    const dto = await loadPlatformConfigAdmin();

    expect(dto).toEqual({ minConsultationMinutes: 15, billingFloorMinutes: 15 });
  });
});
