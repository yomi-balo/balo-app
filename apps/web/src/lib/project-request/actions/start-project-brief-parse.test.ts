import { describe, it, expect, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';

vi.mock('server-only', () => ({}));

const mockCreate = vi.fn();
const mockCountCreatedSince = vi.fn();
const mockMarkFailed = vi.fn();
vi.mock('@balo/db', () => ({
  projectBriefParsesRepository: {
    create: (...args: unknown[]) => mockCreate(...args),
    countCreatedSince: (...args: unknown[]) => mockCountCreatedSince(...args),
    markFailed: (...args: unknown[]) => mockMarkFailed(...args),
  },
}));

const mockPostBaloApiJson = vi.fn();
vi.mock('@/lib/api/balo-api-client', () => ({
  postBaloApiJson: (...args: unknown[]) => mockPostBaloApiJson(...args),
}));

let mockSessionObj: Record<string, unknown>;
vi.mock('@/lib/auth/session', () => ({
  getSession: vi.fn(() => Promise.resolve(mockSessionObj)),
}));

import { startProjectBriefParseAction } from './start-project-brief-parse';

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_COMPANY = '99999999-9999-4999-8999-999999999999';
const DOC_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const VALID_KEY = `project-documents/${COMPANY_ID}/${USER_ID}/${DOC_ID}`;

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    r2Key: VALID_KEY,
    fileName: 'rfp.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    ...overrides,
  };
}

describe('startProjectBriefParseAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionObj = { user: { id: USER_ID, onboardingCompleted: true, companyId: COMPANY_ID } };
    mockCountCreatedSince.mockResolvedValue(0);
  });

  it('rejects a foreign-company document key — no row written, no hop made', async () => {
    const foreignKey = `project-documents/${OTHER_COMPANY}/${USER_ID}/${DOC_ID}`;
    const result = await startProjectBriefParseAction({ documents: [doc({ r2Key: foreignKey })] });

    expect(result).toEqual({ success: false, error: 'Invalid upload key.' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockPostBaloApiJson).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'Project brief parse rejected — document key outside session scope',
      expect.objectContaining({ userId: USER_ID, companyId: COMPANY_ID })
    );
    // The key itself must never be logged.
    const warnCall = vi.mocked(log.warn).mock.calls[0];
    expect(JSON.stringify(warnCall)).not.toContain(foreignKey);
  });

  it('rejects when total bytes exceed the cap', async () => {
    const result = await startProjectBriefParseAction({
      documents: [doc({ sizeBytes: 11 * 1024 * 1024 })],
    });
    expect(result.success).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects when the hourly cap is exceeded', async () => {
    mockCountCreatedSince.mockResolvedValue(12);
    const result = await startProjectBriefParseAction({ documents: [doc()] });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/last hour/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('marks the row failed and returns the generic error when the hop fails', async () => {
    mockCreate.mockResolvedValue({ id: 'parse-1' });
    mockPostBaloApiJson.mockResolvedValue({ ok: false, status: 503, code: 'enqueue_failed' });

    const result = await startProjectBriefParseAction({ documents: [doc()] });

    expect(result.success).toBe(false);
    expect(mockMarkFailed).toHaveBeenCalledWith({
      parseId: 'parse-1',
      failureReason: 'enqueue_failed',
    });
  });

  it('happy path returns the parseId', async () => {
    mockCreate.mockResolvedValue({ id: 'parse-1' });
    mockPostBaloApiJson.mockResolvedValue({ ok: true, data: { enqueued: true } });

    const result = await startProjectBriefParseAction({ documents: [doc()] });

    expect(result).toEqual({ success: true, parseId: 'parse-1' });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: COMPANY_ID, requestedByUserId: USER_ID })
    );
  });

  it('rejects an empty documents array', async () => {
    const result = await startProjectBriefParseAction({ documents: [] });
    expect(result.success).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
