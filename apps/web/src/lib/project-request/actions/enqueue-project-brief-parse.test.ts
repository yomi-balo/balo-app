import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { log } from '@/lib/logging';
import { enqueueProjectBriefParse } from './enqueue-project-brief-parse';

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CASE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

beforeEach(() => {
  vi.clearAllMocks();
  mockCountCreatedSince.mockResolvedValue(0);
});

describe('enqueueProjectBriefParse', () => {
  it('rejects when the hourly cap is exceeded, for a documents source — no row written', async () => {
    mockCountCreatedSince.mockResolvedValue(12);

    const result = await enqueueProjectBriefParse({
      companyId: COMPANY_ID,
      userId: USER_ID,
      source: { source: 'documents', sourceDocuments: [] },
      logContext: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/last hour/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects when the hourly cap is exceeded, for a case source — the budget is shared', async () => {
    mockCountCreatedSince.mockResolvedValue(12);

    const result = await enqueueProjectBriefParse({
      companyId: COMPANY_ID,
      userId: USER_ID,
      source: { source: 'case', sourceEngagementId: CASE_ID },
      logContext: { caseId: CASE_ID },
    });

    expect(result.success).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('creates a documents-source row with the discriminant and the document list', async () => {
    mockCreate.mockResolvedValue({ id: 'parse-1' });
    mockPostBaloApiJson.mockResolvedValue({ ok: true, data: { enqueued: true } });

    await enqueueProjectBriefParse({
      companyId: COMPANY_ID,
      userId: USER_ID,
      source: {
        source: 'documents',
        sourceDocuments: [
          { r2Key: 'k', fileName: 'f.pdf', contentType: 'application/pdf', sizeBytes: 10 },
        ],
      },
      logContext: { documentCount: 1 },
    });

    expect(mockCreate).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      requestedByUserId: USER_ID,
      source: 'documents',
      sourceDocuments: [
        { r2Key: 'k', fileName: 'f.pdf', contentType: 'application/pdf', sizeBytes: 10 },
      ],
    });
  });

  it('creates a case-source row with the discriminant and the engagement id', async () => {
    mockCreate.mockResolvedValue({ id: 'parse-2' });
    mockPostBaloApiJson.mockResolvedValue({ ok: true, data: { enqueued: true } });

    await enqueueProjectBriefParse({
      companyId: COMPANY_ID,
      userId: USER_ID,
      source: { source: 'case', sourceEngagementId: CASE_ID },
      logContext: { caseId: CASE_ID },
    });

    expect(mockCreate).toHaveBeenCalledWith({
      companyId: COMPANY_ID,
      requestedByUserId: USER_ID,
      source: 'case',
      sourceEngagementId: CASE_ID,
    });
  });

  it('marks the row failed and returns the generic error when the hop fails', async () => {
    mockCreate.mockResolvedValue({ id: 'parse-3' });
    mockPostBaloApiJson.mockResolvedValue({ ok: false, status: 503, code: 'enqueue_failed' });

    const result = await enqueueProjectBriefParse({
      companyId: COMPANY_ID,
      userId: USER_ID,
      source: { source: 'case', sourceEngagementId: CASE_ID },
      logContext: { caseId: CASE_ID },
    });

    expect(result.success).toBe(false);
    expect(mockMarkFailed).toHaveBeenCalledWith({
      parseId: 'parse-3',
      failureReason: 'enqueue_failed',
    });
    expect(log.error).toHaveBeenCalled();
  });

  it('happy path returns the parseId and folds logContext into the success log', async () => {
    mockCreate.mockResolvedValue({ id: 'parse-4' });
    mockPostBaloApiJson.mockResolvedValue({ ok: true, data: { enqueued: true } });

    const result = await enqueueProjectBriefParse({
      companyId: COMPANY_ID,
      userId: USER_ID,
      source: { source: 'case', sourceEngagementId: CASE_ID },
      logContext: { caseId: CASE_ID },
    });

    expect(result).toEqual({ success: true, parseId: 'parse-4' });
    expect(log.info).toHaveBeenCalledWith(
      'Project brief parse started',
      expect.objectContaining({ parseId: 'parse-4', caseId: CASE_ID })
    );
  });
});
