import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { mockRequireManager, mockSetHidden, mockAfter } = vi.hoisted(() => ({
  mockRequireManager: vi.fn(),
  mockSetHidden: vi.fn(),
  mockAfter: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  companiesRepository: { setReviewNameHidden: (...a: unknown[]) => mockSetHidden(...a) },
}));
vi.mock('./_shared/require-company-details-manager', () => ({
  requireCompanyDetailsManager: () => mockRequireManager(),
}));
vi.mock('@/lib/logging', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock('./_shared/company-details-action', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./_shared/company-details-action')>();
  return { ...actual, afterCompanyDetailsChange: (...a: unknown[]) => mockAfter(...a) };
});

import { setCompanyReviewNameHiddenAction } from './set-company-review-name-hidden';
import { log } from '@/lib/logging';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const STAFF = { id: 'staff-1', platformRole: 'admin' };

const input = (overrides: Record<string, unknown> = {}) =>
  ({ companyId: COMPANY_ID, hidden: true, ...overrides }) as Parameters<
    typeof setCompanyReviewNameHiddenAction
  >[0];

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireManager.mockResolvedValue({ ok: true, user: STAFF });
});

describe('setCompanyReviewNameHiddenAction', () => {
  it('denies before parsing or any repository call', async () => {
    mockRequireManager.mockResolvedValue({ ok: false, error: 'nope' });

    expect(await setCompanyReviewNameHiddenAction({ junk: 1 } as never)).toEqual({
      success: false,
      error: 'nope',
      code: 'denied',
    });
    expect(mockSetHidden).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-uuid company', { companyId: 'x' }],
    ['a non-boolean flag', { hidden: 'yes' }],
    ['an unknown key', { extra: 1 }],
  ])('rejects %s without writing', async (_label, overrides) => {
    expect(await setCompanyReviewNameHiddenAction(input(overrides))).toEqual({
      success: false,
      error: "That request wasn't valid. Refresh and try again.",
    });
    expect(mockSetHidden).not.toHaveBeenCalled();
  });

  it('hides the name and runs side effects', async () => {
    mockSetHidden.mockResolvedValue({ outcome: 'changed', companyName: 'Acme', hidden: true });

    const result = await setCompanyReviewNameHiddenAction(input());

    expect(mockSetHidden).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      hidden: true,
      actorUserId: 'staff-1',
    });
    expect(mockAfter).toHaveBeenCalledWith({
      kind: 'review_name',
      actorUserId: 'staff-1',
      companyId: COMPANY_ID,
      hidden: true,
    });
    expect(result).toEqual({ success: true, message: "Acme's name is now off every review." });
  });

  it('shows the name again with copy that keeps the reviewer choice', async () => {
    mockSetHidden.mockResolvedValue({ outcome: 'changed', companyName: 'Acme', hidden: false });

    const result = await setCompanyReviewNameHiddenAction(input({ hidden: false }));

    expect(mockAfter).toHaveBeenCalledWith(expect.objectContaining({ hidden: false }));
    expect(result).toEqual({
      success: true,
      message: "Acme's name can show on reviews again, where each reviewer chose to show it.",
    });
  });

  it('reports an unchanged value as success with no side effects', async () => {
    mockSetHidden.mockResolvedValue({ outcome: 'unchanged', companyName: 'Acme', hidden: true });

    expect(await setCompanyReviewNameHiddenAction(input())).toEqual({
      success: true,
      message: "Nothing changed — that's already set for Acme.",
    });
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('refuses a personal workspace with its code', async () => {
    mockSetHidden.mockResolvedValue({ outcome: 'personal_workspace', companyName: 'Sam' });

    expect(await setCompanyReviewNameHiddenAction(input())).toEqual({
      success: false,
      error: 'Sam is a personal workspace, so its name never appears on reviews.',
      code: 'personal_workspace',
    });
    expect(mockAfter).not.toHaveBeenCalled();
  });

  it('maps a missing company to not_found', async () => {
    mockSetHidden.mockResolvedValue({ outcome: 'company_not_found' });

    expect(await setCompanyReviewNameHiddenAction(input())).toMatchObject({
      success: false,
      code: 'not_found',
    });
  });

  it('logs and reports a failed save when the repository throws', async () => {
    mockSetHidden.mockRejectedValue(new Error('db down'));

    expect(await setCompanyReviewNameHiddenAction(input())).toEqual({
      success: false,
      error: "Couldn't save that change. Nothing was changed — try again.",
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to change company review-name visibility',
      expect.objectContaining({ companyId: COMPANY_ID, error: 'db down' })
    );
  });
});
