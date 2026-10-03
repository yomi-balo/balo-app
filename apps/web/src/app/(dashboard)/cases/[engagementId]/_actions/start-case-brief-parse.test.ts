import { describe, it, expect, vi, beforeEach } from 'vitest';

const CASE_ID = 'e0000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000003';
const COMPANY_ID = 'a0000000-0000-4000-8000-000000000004';
const EXPERT_PROFILE_ID = 'a0000000-0000-4000-8000-000000000005';
const OTHER_COMPANY_ID = 'a0000000-0000-4000-8000-000000000009';

vi.mock('server-only', () => ({}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockAuthorizeCaseMutation = vi.fn();
vi.mock('../_lib/authorize-case-mutation', () => ({
  authorizeCaseMutation: (...a: unknown[]) => mockAuthorizeCaseMutation(...a),
}));

const mockHasCapability = vi.fn();
vi.mock('@/lib/authz', () => ({
  hasCapability: (...a: unknown[]) => mockHasCapability(...a),
  CAPABILITIES: { PARTICIPATE: 'participate' },
}));

const mockEnqueueProjectBriefParse = vi.fn();
vi.mock('@/lib/project-request/actions/enqueue-project-brief-parse', () => ({
  enqueueProjectBriefParse: (...a: unknown[]) => mockEnqueueProjectBriefParse(...a),
}));

import { log } from '@/lib/logging';
import { startCaseBriefParseAction } from './start-case-brief-parse';

function gateOk(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    user: { id: USER_ID },
    engagementId: CASE_ID,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    lens: 'client',
    caseRow: { title: 'Salesforce integration' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID, companyId: COMPANY_ID });
  mockAuthorizeCaseMutation.mockResolvedValue(gateOk());
  mockHasCapability.mockResolvedValue(true);
  mockEnqueueProjectBriefParse.mockResolvedValue({ success: true, parseId: 'parse-1' });
});

describe('startCaseBriefParseAction', () => {
  it('rejects an un-onboarded session before touching the gate', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('not onboarded'));

    const result = await startCaseBriefParseAction({ caseId: CASE_ID });

    expect(result).toEqual({ success: false, error: 'You are not signed in.' });
    expect(mockAuthorizeCaseMutation).not.toHaveBeenCalled();
    expect(mockEnqueueProjectBriefParse).not.toHaveBeenCalled();
  });

  it('rejects a malformed caseId before touching the gate', async () => {
    const result = await startCaseBriefParseAction({ caseId: 'not-a-uuid' });

    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockAuthorizeCaseMutation).not.toHaveBeenCalled();
  });

  it('denies an expert-lens actor — no enqueue', async () => {
    mockAuthorizeCaseMutation.mockResolvedValue(gateOk({ lens: 'expert' }));

    const result = await startCaseBriefParseAction({ caseId: CASE_ID });

    expect(result).toEqual({
      success: false,
      error: "You don't have permission to draft a project brief from this case.",
    });
    expect(mockEnqueueProjectBriefParse).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('denies an actor missing PARTICIPATE — no enqueue', async () => {
    mockHasCapability.mockResolvedValue(false);

    const result = await startCaseBriefParseAction({ caseId: CASE_ID });

    expect(result).toEqual({
      success: false,
      error: "You don't have permission to draft a project brief from this case.",
    });
    expect(mockEnqueueProjectBriefParse).not.toHaveBeenCalled();
  });

  it('denies a company mismatch between the active session and the gate — no enqueue', async () => {
    mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID, companyId: OTHER_COMPANY_ID });

    const result = await startCaseBriefParseAction({ caseId: CASE_ID });

    expect(result).toEqual({
      success: false,
      error: 'Switch to the workspace this case belongs to.',
    });
    expect(mockEnqueueProjectBriefParse).not.toHaveBeenCalled();
  });

  it('shares the hourly rate limit — a limited enqueue result passes straight through', async () => {
    mockEnqueueProjectBriefParse.mockResolvedValue({
      success: false,
      error:
        "You've generated a lot of briefs in the last hour — give it a few minutes and try again.",
    });

    const result = await startCaseBriefParseAction({ caseId: CASE_ID });

    expect(result.success).toBe(false);
    expect(mockEnqueueProjectBriefParse).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: COMPANY_ID,
        userId: USER_ID,
        source: { source: 'case', sourceEngagementId: CASE_ID },
      })
    );
  });

  it('happy path returns the parseId and logs the case-specific event', async () => {
    const result = await startCaseBriefParseAction({ caseId: CASE_ID });

    expect(result).toEqual({ success: true, parseId: 'parse-1' });
    expect(log.info).toHaveBeenCalledWith('Case brief parse started', {
      caseId: CASE_ID,
      parseId: 'parse-1',
    });
  });
});
