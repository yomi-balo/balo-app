import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockLogInfo, mockLogError, mockTrack, mockRevalidate } = vi.hoisted(() => ({
  mockLogInfo: vi.fn(),
  mockLogError: vi.fn(),
  mockTrack: vi.fn(),
  mockRevalidate: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  log: { info: mockLogInfo, error: mockLogError, warn: vi.fn() },
}));
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => mockRevalidate(...a) }));
vi.mock('@/lib/analytics/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/analytics/server')>();
  return { ...actual, trackServerAndFlush: (...a: unknown[]) => mockTrack(...a) };
});

import {
  afterCompanyDetailsChange,
  denied,
  failure,
  personalWorkspaceError,
  saveFailed,
  SAVE_FAILED_ERROR,
} from './company-details-action';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => vi.clearAllMocks());

describe('result builders', () => {
  it('builds denied and failure results', () => {
    expect(denied('no')).toEqual({ success: false, error: 'no', code: 'denied' });
    expect(failure('x')).toEqual({ success: false, error: 'x' });
    expect(failure('x', 'not_found')).toEqual({ success: false, error: 'x', code: 'not_found' });
  });

  it('names the personal workspace in its copy', () => {
    expect(personalWorkspaceError('Sam')).toBe(
      'Sam is a personal workspace, so its name never appears on reviews.'
    );
  });

  it('saveFailed logs the error and returns the generic failure', () => {
    expect(saveFailed('Boom', { companyId: COMPANY_ID }, new Error('db'))).toEqual({
      success: false,
      error: SAVE_FAILED_ERROR,
    });
    expect(mockLogError).toHaveBeenCalledWith(
      'Boom',
      expect.objectContaining({ companyId: COMPANY_ID, error: 'db' })
    );
  });

  it('saveFailed stringifies a non-Error throw', () => {
    saveFailed('Boom', {}, 'plain');
    expect(mockLogError).toHaveBeenCalledWith(
      'Boom',
      expect.objectContaining({ error: 'plain', stack: undefined })
    );
  });
});

describe('afterCompanyDetailsChange', () => {
  it('logs, tracks and revalidates an industry change with ids only', () => {
    afterCompanyDetailsChange({
      kind: 'industry',
      actorUserId: 'staff-1',
      companyId: COMPANY_ID,
      cleared: true,
    });

    expect(mockLogInfo).toHaveBeenCalledWith('Company industry set by staff', {
      companyId: COMPANY_ID,
      actorUserId: 'staff-1',
      cleared: true,
    });
    expect(mockTrack).toHaveBeenCalledWith('admin_company_industry_set', {
      cleared: true,
      distinct_id: 'staff-1',
    });
    expect(mockRevalidate).toHaveBeenCalledWith(`/admin/companies/${COMPANY_ID}`);
  });

  it('logs, tracks and revalidates a review-name change', () => {
    afterCompanyDetailsChange({
      kind: 'review_name',
      actorUserId: 'staff-1',
      companyId: COMPANY_ID,
      hidden: true,
    });

    expect(mockLogInfo).toHaveBeenCalledWith('Company review-name visibility changed by staff', {
      companyId: COMPANY_ID,
      actorUserId: 'staff-1',
      hidden: true,
    });
    expect(mockTrack).toHaveBeenCalledWith('admin_company_review_name_toggled', {
      hidden: true,
      distinct_id: 'staff-1',
    });
    expect(mockRevalidate).toHaveBeenCalledWith(`/admin/companies/${COMPANY_ID}`);
  });

  it('never throws and still runs later steps when one step fails', () => {
    mockTrack.mockImplementation(() => {
      throw new Error('posthog down');
    });

    expect(() =>
      afterCompanyDetailsChange({
        kind: 'industry',
        actorUserId: 'staff-1',
        companyId: COMPANY_ID,
        cleared: false,
      })
    ).not.toThrow();

    expect(mockLogError).toHaveBeenCalledWith(
      'A post-commit step failed after a staff company-details change',
      expect.objectContaining({ kind: 'industry', step: 'analytics', error: 'posthog down' })
    );
    expect(mockRevalidate).toHaveBeenCalled();
  });
});
