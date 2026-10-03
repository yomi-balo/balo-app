import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockAuthorizeClientCaseMutation = vi.fn();
vi.mock('@/app/(dashboard)/cases/[engagementId]/_lib/authorize-client-case-mutation', () => ({
  authorizeClientCaseMutation: (...args: unknown[]) => mockAuthorizeClientCaseMutation(...args),
}));

import { log } from '@/lib/logging';
import type { SessionUser } from '@/lib/auth/session';
import { authorizeSourceCase } from './authorize-source-case';

const CASE_ID = 'd0000000-0000-4000-8000-000000000007';
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_COMPANY_ID = 'd0000000-0000-4000-8000-000000000008';
const EXPERT_PROFILE_ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_EXPERT_PROFILE_ID = 'd0000000-0000-4000-8000-000000000009';

function buildUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: USER_ID,
    email: 'person@balo.expert',
    firstName: 'Sam',
    lastName: 'Sample',
    avatarUrl: null,
    activeMode: 'client',
    onboardingCompleted: true,
    platformRole: 'user',
    companyId: COMPANY_ID,
    companyName: 'Northwind',
    companyRole: 'owner',
    ...overrides,
  };
}

function gateOk(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
    caseRow: { title: 'Salesforce integration cleanup' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authorizeSourceCase', () => {
  it('short-circuits to ok/null when sourceCaseId is absent — no gate call', async () => {
    const result = await authorizeSourceCase({
      sourceCaseId: undefined,
      sendTo: 'direct',
      directExpertProfileId: EXPERT_PROFILE_ID,
      user: buildUser(),
    });

    expect(result).toEqual({ ok: true, sourceCase: null });
    expect(mockAuthorizeClientCaseMutation).not.toHaveBeenCalled();
  });

  it('propagates a denied case gate (e.g. an expert-lens actor)', async () => {
    mockAuthorizeClientCaseMutation.mockResolvedValue({
      ok: false,
      error: "You don't have permission to convert this case.",
    });

    const result = await authorizeSourceCase({
      sourceCaseId: CASE_ID,
      sendTo: 'direct',
      directExpertProfileId: EXPERT_PROFILE_ID,
      user: buildUser(),
    });

    expect(result).toEqual({
      ok: false,
      error: "You don't have permission to convert this case.",
    });
    expect(log.warn).toHaveBeenCalledWith(
      'Project request rejected — case gate denied',
      expect.objectContaining({ sourceCaseId: CASE_ID })
    );
  });

  it('rejects a case belonging to another company', async () => {
    mockAuthorizeClientCaseMutation.mockResolvedValue(gateOk({ companyId: OTHER_COMPANY_ID }));

    const result = await authorizeSourceCase({
      sourceCaseId: CASE_ID,
      sendTo: 'direct',
      directExpertProfileId: EXPERT_PROFILE_ID,
      user: buildUser(),
    });

    expect(result).toEqual({
      ok: false,
      error: 'Switch to the workspace this case belongs to.',
    });
  });

  it("rejects a direct submit to an expert other than the case's own", async () => {
    mockAuthorizeClientCaseMutation.mockResolvedValue(
      gateOk({ expertProfileId: OTHER_EXPERT_PROFILE_ID })
    );

    const result = await authorizeSourceCase({
      sourceCaseId: CASE_ID,
      sendTo: 'direct',
      directExpertProfileId: EXPERT_PROFILE_ID,
      user: buildUser(),
    });

    expect(result).toEqual({ ok: false, error: "This case isn't with that expert." });
  });

  it('skips the expert-match check for a match submit, even with a mismatched case expert', async () => {
    mockAuthorizeClientCaseMutation.mockResolvedValue(
      gateOk({ expertProfileId: OTHER_EXPERT_PROFILE_ID })
    );

    const result = await authorizeSourceCase({
      sourceCaseId: CASE_ID,
      sendTo: 'match',
      directExpertProfileId: null,
      user: buildUser(),
    });

    expect(result).toEqual({
      ok: true,
      sourceCase: { id: CASE_ID, title: 'Salesforce integration cleanup' },
    });
  });

  it('happy path returns the sourceCase info for a matching direct submit', async () => {
    mockAuthorizeClientCaseMutation.mockResolvedValue(gateOk());

    const result = await authorizeSourceCase({
      sourceCaseId: CASE_ID,
      sendTo: 'direct',
      directExpertProfileId: EXPERT_PROFILE_ID,
      user: buildUser(),
    });

    expect(result).toEqual({
      ok: true,
      sourceCase: { id: CASE_ID, title: 'Salesforce integration cleanup' },
    });
  });
});
