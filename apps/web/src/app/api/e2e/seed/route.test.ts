import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { log } from '@/lib/logging';

// ── Mocks ───────────────────────────────────────────────────────

const {
  mockGetSalesforceVertical,
  mockUsersCreate,
  mockFindOrCreateDraft,
  mockUpdateProfile,
  mockSubmitApplication,
  mockApproveApplication,
  mockReplaceForExpert,
  mockApplySearchable,
  mockFindOrCreateDomainMembership,
  mockCaseCreate,
  mockDbReturning,
  mockDbValues,
  mockDbInsert,
  mockGetSession,
  mockDeriveBookingIdempotencyKey,
  fakeSession,
} = vi.hoisted(() => {
  const returning = vi.fn();
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const session: { user?: unknown } = { user: undefined };
  return {
    mockGetSalesforceVertical: vi.fn(),
    mockUsersCreate: vi.fn(),
    mockFindOrCreateDraft: vi.fn(),
    mockUpdateProfile: vi.fn(),
    mockSubmitApplication: vi.fn(),
    mockApproveApplication: vi.fn(),
    mockReplaceForExpert: vi.fn(),
    mockApplySearchable: vi.fn(),
    mockFindOrCreateDomainMembership: vi.fn(),
    mockCaseCreate: vi.fn(),
    mockDbReturning: returning,
    mockDbValues: values,
    mockDbInsert: insert,
    mockGetSession: vi.fn(),
    mockDeriveBookingIdempotencyKey: vi.fn(),
    fakeSession: session,
  };
});

vi.mock('@balo/db', () => ({
  db: { insert: mockDbInsert },
  companies: { __table: 'companies' },
  referenceDataRepository: { getSalesforceVertical: mockGetSalesforceVertical },
  usersRepository: { create: mockUsersCreate },
  expertsRepository: {
    findOrCreateDraft: mockFindOrCreateDraft,
    updateProfile: mockUpdateProfile,
    submitApplication: mockSubmitApplication,
    approveApplication: mockApproveApplication,
  },
  availabilityRulesRepository: { replaceForExpert: mockReplaceForExpert },
  expertSearchabilityRepository: { applySearchable: mockApplySearchable },
  partyMembershipsRepository: { findOrCreateDomainMembership: mockFindOrCreateDomainMembership },
  caseEngagementsRepository: { create: mockCaseCreate },
}));

vi.mock('@/lib/auth/session', () => ({
  getSession: mockGetSession,
}));

vi.mock('@/lib/booking/booking-idempotency', () => ({
  deriveBookingIdempotencyKey: mockDeriveBookingIdempotencyKey,
}));

import { POST } from './route';

// ── Helpers ─────────────────────────────────────────────────────

const TEST_SECRET = 'e2e-test-secret-value-at-least-32-chars-long';

function makeRequest(body: unknown, secret?: string | null): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret != null) headers['x-e2e-secret'] = secret;
  return new NextRequest('http://localhost:3000/api/e2e/seed', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function enableSecret(): void {
  vi.stubEnv('E2E_TEST_SECRET', TEST_SECRET);
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeSession.user = undefined;
  mockGetSession.mockResolvedValue(fakeSession);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/e2e/seed — secret gate', () => {
  it('returns 404 when E2E_TEST_SECRET is unset, and touches NO repository', async () => {
    vi.stubEnv('E2E_TEST_SECRET', '');
    const res = await POST(makeRequest({ kind: 'expert' }, TEST_SECRET));
    expect(res.status).toBe(404);
    expect(mockFindOrCreateDraft).not.toHaveBeenCalled();
    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(mockCaseCreate).not.toHaveBeenCalled();
  });

  it('returns 401 for a wrong secret, and touches NO repository', async () => {
    enableSecret();
    const res = await POST(makeRequest({ kind: 'expert' }, 'wrong-secret-wrong-secret-wrong'));
    expect(res.status).toBe(401);
    expect(mockFindOrCreateDraft).not.toHaveBeenCalled();
  });

  it('returns 401 when the header is missing entirely', async () => {
    enableSecret();
    const res = await POST(makeRequest({ kind: 'expert' }));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/e2e/seed — validation', () => {
  it('returns 400 for an unknown kind', async () => {
    enableSecret();
    const res = await POST(makeRequest({ kind: 'nonsense' }, TEST_SECRET));
    expect(res.status).toBe(400);
  });

  it('returns 400 for a case request missing required fields', async () => {
    enableSecret();
    const res = await POST(makeRequest({ kind: 'case' }, TEST_SECRET));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/e2e/seed — kind: expert', () => {
  it('creates an approved, searchable expert with wide-open weekly hours', async () => {
    enableSecret();
    mockGetSalesforceVertical.mockResolvedValue({ id: 'vertical-1' });
    mockUsersCreate.mockResolvedValue({
      id: 'owner-1',
      firstName: 'Sam',
      lastName: 'Consultant',
    });
    mockFindOrCreateDraft.mockResolvedValue({ id: 'expert-1' });

    const res = await POST(makeRequest({ kind: 'expert' }, TEST_SECRET));
    const json: unknown = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, expertProfileId: 'expert-1' });
    expect(mockUpdateProfile).toHaveBeenCalledWith(
      'expert-1',
      expect.objectContaining({ username: expect.stringMatching(/^e2e-expert-/) })
    );
    expect(mockSubmitApplication).toHaveBeenCalledWith('expert-1');
    expect(mockApproveApplication).toHaveBeenCalledWith('expert-1');
    expect(mockReplaceForExpert).toHaveBeenCalledWith(
      'expert-1',
      expect.arrayContaining([expect.objectContaining({ dayOfWeek: 0 })])
    );
    // 7 days, every day wide open — this is what makes a slot always resolvable.
    expect(mockReplaceForExpert.mock.calls[0]?.[1]).toHaveLength(7);
    expect(mockApplySearchable).toHaveBeenCalledWith(
      expect.objectContaining({ expertProfileId: 'expert-1', searchable: true })
    );
    // Standalone — no session needed for this kind.
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it('returns 500 and logs when a repository call throws', async () => {
    enableSecret();
    mockGetSalesforceVertical.mockRejectedValue(new Error('taxonomy down'));
    const res = await POST(makeRequest({ kind: 'expert' }, TEST_SECRET));
    expect(res.status).toBe(500);
    expect(log.error).toHaveBeenCalled();
  });
});

describe('POST /api/e2e/seed — kind: company', () => {
  it('refuses when there is no active session', async () => {
    enableSecret();
    fakeSession.user = undefined;
    const res = await POST(makeRequest({ kind: 'company' }, TEST_SECRET));
    expect(res.status).toBe(400);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('inserts a second, non-personal company and an audited membership for the session user', async () => {
    enableSecret();
    fakeSession.user = { id: 'user-1', companyId: 'company-1' };
    mockDbReturning.mockResolvedValue([{ id: 'company-2', name: 'E2E Co abc12345' }]);
    mockFindOrCreateDomainMembership.mockResolvedValue({
      outcome: 'joined',
      membershipId: 'membership-1',
    });

    const res = await POST(makeRequest({ kind: 'company' }, TEST_SECRET));
    const json: unknown = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, companyId: 'company-2' });
    expect(mockDbValues).toHaveBeenCalledWith(
      expect.objectContaining({ isPersonal: false, name: expect.any(String) })
    );
    expect(mockFindOrCreateDomainMembership).toHaveBeenCalledWith(
      expect.objectContaining({ partyType: 'company', partyId: 'company-2', userId: 'user-1' })
    );
  });
});

describe('POST /api/e2e/seed — kind: case', () => {
  it('refuses when there is no active session', async () => {
    enableSecret();
    fakeSession.user = undefined;
    const res = await POST(
      makeRequest(
        {
          kind: 'case',
          expertProfileId: '11111111-1111-4111-8111-111111111111',
          title: 'Need help',
        },
        TEST_SECRET
      )
    );
    expect(res.status).toBe(400);
    expect(mockCaseCreate).not.toHaveBeenCalled();
  });

  it('creates an open case for the session user’s primary company with NO idempotency key when no nonce is given', async () => {
    enableSecret();
    fakeSession.user = { id: 'user-1', companyId: 'company-1' };
    mockCaseCreate.mockResolvedValue({ id: 'engagement-1', title: 'Need help with a flow' });

    const res = await POST(
      makeRequest(
        {
          kind: 'case',
          expertProfileId: '11111111-1111-4111-8111-111111111111',
          title: 'Need help with a flow',
        },
        TEST_SECRET
      )
    );
    const json: unknown = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, engagementId: 'engagement-1' });
    expect(mockCaseCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        expertProfileId: '11111111-1111-4111-8111-111111111111',
        title: 'Need help with a flow',
        actorUserId: 'user-1',
        bookingIdempotencyKey: undefined,
      })
    );
    expect(mockDeriveBookingIdempotencyKey).not.toHaveBeenCalled();
  });

  it('derives the SAME key production booking would, from a given bookingNonce (partial-failure replay setup)', async () => {
    enableSecret();
    fakeSession.user = { id: 'user-1', companyId: 'company-1' };
    mockDeriveBookingIdempotencyKey.mockReturnValue('a'.repeat(64));
    mockCaseCreate.mockResolvedValue({ id: 'engagement-1', title: 'Need help with a flow' });

    const nonce = '22222222-2222-4222-8222-222222222222';
    const res = await POST(
      makeRequest(
        {
          kind: 'case',
          expertProfileId: '11111111-1111-4111-8111-111111111111',
          title: 'Need help with a flow',
          bookingNonce: nonce,
        },
        TEST_SECRET
      )
    );

    expect(res.status).toBe(200);
    expect(mockDeriveBookingIdempotencyKey).toHaveBeenCalledWith('user-1', nonce);
    expect(mockCaseCreate).toHaveBeenCalledWith(
      expect.objectContaining({ bookingIdempotencyKey: 'a'.repeat(64) })
    );
  });
});
