import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────
// The @balo/db repos are mocked; @balo/shared/domains is REAL (pure logic).

const {
  mockFindActiveByDomain,
  mockGetPartyJoinSettings,
  mockFindOrCreateDomainMembership,
  mockFindOrCreatePending,
  mockOptoutExists,
} = vi.hoisted(() => ({
  mockFindActiveByDomain: vi.fn(),
  mockGetPartyJoinSettings: vi.fn(),
  mockFindOrCreateDomainMembership: vi.fn(),
  mockFindOrCreatePending: vi.fn(),
  mockOptoutExists: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  partyDomainsRepository: { findActiveByDomain: mockFindActiveByDomain },
  partyMembershipsRepository: {
    getPartyJoinSettings: mockGetPartyJoinSettings,
    findOrCreateDomainMembership: mockFindOrCreateDomainMembership,
  },
  partyJoinRequestsRepository: { findOrCreatePending: mockFindOrCreatePending },
  partyJoinOptoutsRepository: { exists: mockOptoutExists },
}));

const mockPublish = vi.fn<(...a: unknown[]) => Promise<void>>(() => Promise.resolve());
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...args: unknown[]) => mockPublish(...args),
}));

const { mockEmitSignupDomainMatched, mockEmitAutoJoinCompleted, mockEmitJoinRequestCreated } =
  vi.hoisted(() => ({
    mockEmitSignupDomainMatched: vi.fn(),
    mockEmitAutoJoinCompleted: vi.fn(),
    mockEmitJoinRequestCreated: vi.fn(),
  }));
vi.mock('@/lib/analytics/party-join', () => ({
  emitSignupDomainMatched: (...a: unknown[]) => mockEmitSignupDomainMatched(...a),
  emitAutoJoinCompleted: (...a: unknown[]) => mockEmitAutoJoinCompleted(...a),
  emitJoinRequestCreated: (...a: unknown[]) => mockEmitJoinRequestCreated(...a),
}));

const { mockEmitClassified } = vi.hoisted(() => ({ mockEmitClassified: vi.fn() }));
vi.mock('@/lib/analytics/signup-domain', () => ({
  emitSignupDomainClassified: (...a: unknown[]) => mockEmitClassified(...a),
}));

const mockLogError = vi.fn();
vi.mock('@/lib/logging', () => ({ log: { error: (...a: unknown[]) => mockLogError(...a) } }));

import { runDomainJoin, runDomainJoinAndEmit } from './run-domain-join';

// ── Helpers ─────────────────────────────────────────────────────

const CORP_EMAIL = 'newhire@acme.io'; // acme.io is not freemail/disposable
const USER_ID = 'user-1';

function settings(over: Record<string, unknown> = {}) {
  return { domainJoinMode: 'auto', membershipAuthority: 'balo', isPersonal: false, ...over };
}

function companyOwner() {
  return { partyType: 'company', partyId: 'party-1' };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOptoutExists.mockResolvedValue(false);
});

// ── Decision tree ───────────────────────────────────────────────

describe('runDomainJoin — decision tree', () => {
  it('unverified email → unverified (no repo calls)', async () => {
    const result = await runDomainJoin({
      userId: USER_ID,
      email: CORP_EMAIL,
      emailVerified: false,
    });
    expect(result).toEqual({ outcome: 'unverified' });
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
  });

  it('email with no domain part → no_domain', async () => {
    const result = await runDomainJoin({ userId: USER_ID, email: 'garbage', emailVerified: true });
    expect(result).toEqual({ outcome: 'no_domain' });
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
  });

  it('blocked (freemail) domain → blocked (no lookup)', async () => {
    const result = await runDomainJoin({
      userId: USER_ID,
      email: 'someone@gmail.com',
      emailVerified: true,
    });
    expect(result).toEqual({ outcome: 'blocked' });
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
  });

  it('no owning party → no_match', async () => {
    mockFindActiveByDomain.mockResolvedValue(undefined);
    const result = await runDomainJoin({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });
    expect(result).toEqual({ outcome: 'no_match' });
    expect(mockFindActiveByDomain).toHaveBeenCalledWith('acme.io');
  });

  it('undefined settings (party row absent) → no_match', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(undefined);
    const result = await runDomainJoin({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });
    expect(result).toEqual({ outcome: 'no_match' });
  });

  it('isPersonal company → no_match (STAND-DOWN, no write)', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings({ isPersonal: true }));
    const result = await runDomainJoin({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });
    expect(result).toEqual({ outcome: 'no_match' });
    expect(mockFindOrCreateDomainMembership).not.toHaveBeenCalled();
    expect(mockFindOrCreatePending).not.toHaveBeenCalled();
  });

  it('directory authority → directory_authority', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings({ membershipAuthority: 'directory' }));
    const result = await runDomainJoin({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });
    expect(result).toEqual({ outcome: 'directory_authority' });
  });

  it('mode off → mode_off', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings({ domainJoinMode: 'off' }));
    const result = await runDomainJoin({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });
    expect(result).toEqual({ outcome: 'mode_off' });
  });

  it('opted out → opted_out (no write)', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings());
    mockOptoutExists.mockResolvedValue(true);
    const result = await runDomainJoin({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });
    expect(result).toEqual({ outcome: 'opted_out' });
    expect(mockFindOrCreateDomainMembership).not.toHaveBeenCalled();
  });

  it('auto mode joined → auto_joined + membershipId', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings());
    mockFindOrCreateDomainMembership.mockResolvedValue({ outcome: 'joined', membershipId: 'm-1' });
    const result = await runDomainJoin({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });
    expect(result).toEqual({
      outcome: 'auto_joined',
      partyType: 'company',
      partyId: 'party-1',
      mode: 'auto',
      membershipId: 'm-1',
    });
    expect(mockFindOrCreateDomainMembership).toHaveBeenCalledWith({
      partyType: 'company',
      partyId: 'party-1',
      userId: USER_ID,
      actorUserId: USER_ID,
    });
  });

  it('auto mode already_member → auto_already_member (idempotent)', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings());
    mockFindOrCreateDomainMembership.mockResolvedValue({
      outcome: 'already_member',
      membershipId: 'm-1',
    });
    const result = await runDomainJoin({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });
    expect(result.outcome).toBe('auto_already_member');
  });

  it('request mode created → request_created + joinRequestId', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings({ domainJoinMode: 'request' }));
    mockFindOrCreatePending.mockResolvedValue({ outcome: 'created', request: { id: 'r-1' } });
    const result = await runDomainJoin({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });
    expect(result).toEqual({
      outcome: 'request_created',
      partyType: 'company',
      partyId: 'party-1',
      mode: 'request',
      joinRequestId: 'r-1',
    });
  });

  it('request mode already_pending → request_already_pending', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings({ domainJoinMode: 'request' }));
    mockFindOrCreatePending.mockResolvedValue({
      outcome: 'already_pending',
      request: { id: 'r-1' },
    });
    const result = await runDomainJoin({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });
    expect(result.outcome).toBe('request_already_pending');
  });
});

// ── Emit wiring (runDomainJoinAndEmit) ──────────────────────────

describe('runDomainJoinAndEmit — analytics + notifications', () => {
  it('auto_joined → matched + completion analytics + member_joined notification', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings());
    mockFindOrCreateDomainMembership.mockResolvedValue({ outcome: 'joined', membershipId: 'm-1' });

    await runDomainJoinAndEmit({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });

    expect(mockEmitSignupDomainMatched).toHaveBeenCalledWith('company', 'auto', USER_ID);
    expect(mockEmitAutoJoinCompleted).toHaveBeenCalledWith('company', USER_ID);
    expect(mockPublish).toHaveBeenCalledWith('party.member_joined_via_domain', {
      correlationId: 'm-1',
      partyType: 'company',
      partyId: 'party-1',
      userId: USER_ID,
    });
  });

  it('auto_already_member → matched analytics only (no completion, no notification)', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings());
    mockFindOrCreateDomainMembership.mockResolvedValue({
      outcome: 'already_member',
      membershipId: 'm-1',
    });

    await runDomainJoinAndEmit({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });

    expect(mockEmitSignupDomainMatched).toHaveBeenCalledWith('company', 'auto', USER_ID);
    expect(mockEmitAutoJoinCompleted).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('request_created → matched + request analytics + request_created notification', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings({ domainJoinMode: 'request' }));
    mockFindOrCreatePending.mockResolvedValue({ outcome: 'created', request: { id: 'r-1' } });

    await runDomainJoinAndEmit({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });

    expect(mockEmitSignupDomainMatched).toHaveBeenCalledWith('company', 'request', USER_ID);
    expect(mockEmitJoinRequestCreated).toHaveBeenCalledWith('company', USER_ID);
    expect(mockPublish).toHaveBeenCalledWith('party.join_request_created', {
      correlationId: 'r-1',
      partyType: 'company',
      partyId: 'party-1',
      userId: USER_ID,
    });
  });

  it('no_match (stand-down) → emits nothing', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings({ isPersonal: true }));

    await runDomainJoinAndEmit({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });

    expect(mockEmitSignupDomainMatched).not.toHaveBeenCalled();
    expect(mockEmitAutoJoinCompleted).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('swallows a thrown error (auth unaffected) and logs it', async () => {
    mockFindActiveByDomain.mockRejectedValue(new Error('db down'));

    await expect(
      runDomainJoinAndEmit({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true })
    ).resolves.toBeUndefined();

    expect(mockLogError).toHaveBeenCalledWith(
      'Domain join failed (auth unaffected)',
      expect.objectContaining({ userId: USER_ID, error: 'db down' })
    );
  });
});

// ── Signup domain classification (BAL-368 / ADR-1038 S1) ─────────
// The classification emit is DECOUPLED from the join engine's emailVerified gate
// and from every stand-down: every signup is typed exactly once, regardless of
// whether the join engine later matches, stands down, or is skipped as unverified.

const FREEMAIL_EMAIL = 'someone@gmail.com';

describe('runDomainJoinAndEmit — signup domain classification', () => {
  it('classifies a corporate email as corporate exactly once (auto_joined path)', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings());
    mockFindOrCreateDomainMembership.mockResolvedValue({ outcome: 'joined', membershipId: 'm-1' });

    await runDomainJoinAndEmit({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });

    expect(mockEmitClassified).toHaveBeenCalledTimes(1);
    expect(mockEmitClassified).toHaveBeenCalledWith('corporate', USER_ID);
  });

  it('classifies a freemail email as freemail (join stands down as blocked)', async () => {
    await runDomainJoinAndEmit({ userId: USER_ID, email: FREEMAIL_EMAIL, emailVerified: true });

    expect(mockEmitClassified).toHaveBeenCalledTimes(1);
    expect(mockEmitClassified).toHaveBeenCalledWith('freemail', USER_ID);
    // Blocked freemail never reaches the owner lookup.
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
  });

  it('still classifies on a join stand-down (isPersonal no_match)', async () => {
    mockFindActiveByDomain.mockResolvedValue(companyOwner());
    mockGetPartyJoinSettings.mockResolvedValue(settings({ isPersonal: true }));

    await runDomainJoinAndEmit({ userId: USER_ID, email: CORP_EMAIL, emailVerified: true });

    expect(mockEmitClassified).toHaveBeenCalledTimes(1);
    expect(mockEmitClassified).toHaveBeenCalledWith('corporate', USER_ID);
    // Proof of decoupling: the join itself emitted nothing (stand-down).
    expect(mockEmitSignupDomainMatched).not.toHaveBeenCalled();
  });

  it('still classifies when the email is unverified (join engine returns unverified)', async () => {
    await runDomainJoinAndEmit({ userId: USER_ID, email: CORP_EMAIL, emailVerified: false });

    expect(mockEmitClassified).toHaveBeenCalledTimes(1);
    expect(mockEmitClassified).toHaveBeenCalledWith('corporate', USER_ID);
    // The join engine short-circuits on the unverified gate — no lookup, no match emit.
    expect(mockFindActiveByDomain).not.toHaveBeenCalled();
    expect(mockEmitSignupDomainMatched).not.toHaveBeenCalled();
  });
});
