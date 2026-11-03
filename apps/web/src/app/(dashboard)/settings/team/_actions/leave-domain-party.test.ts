import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLeaveDomainParty = vi.fn();
vi.mock('@balo/db', () => ({
  partyJoinRepository: { leaveDomainParty: (...a: unknown[]) => mockLeaveDomainParty(...a) },
}));

const mockRequireUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({ requireOnboardedUser: () => mockRequireUser() }));

const mockEmitOptedOut = vi.fn();
vi.mock('@/lib/analytics/party-join', () => ({
  emitDomainJoinOptedOut: (...a: unknown[]) => mockEmitOptedOut(...a),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/logging', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { log } from '@/lib/logging';
import { leaveDomainParty } from './leave-domain-party';

const PARTY_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: 'me-1', firstName: 'Dana', lastName: 'Whitfield' });
});

describe('leaveDomainParty (escape hatch)', () => {
  it('passes the SESSION user id (never a client-supplied one) to the orchestrator', async () => {
    mockLeaveDomainParty.mockResolvedValue({ path: 'auto', changed: true, soloAgencyId: null });

    const result = await leaveDomainParty({ partyType: 'company', partyId: PARTY_ID });

    expect(result).toEqual({ success: true });
    expect(mockLeaveDomainParty).toHaveBeenCalledWith({
      partyType: 'company',
      partyId: PARTY_ID,
      userId: 'me-1',
      soloAgencyName: 'Dana Whitfield',
    });
  });

  it('logs the repoint only when an agency-of-one was created', async () => {
    mockLeaveDomainParty.mockResolvedValue({ path: 'auto', changed: true, soloAgencyId: 'solo-1' });
    await leaveDomainParty({ partyType: 'agency', partyId: PARTY_ID });
    expect(log.info).toHaveBeenCalledWith(
      'Expert left agency; profile repointed to a new agency-of-one',
      { partyId: PARTY_ID, soloAgencyId: 'solo-1', actorUserId: 'me-1' }
    );

    vi.mocked(log.info).mockClear();
    mockLeaveDomainParty.mockResolvedValue({ path: 'auto', changed: true, soloAgencyId: null });
    await leaveDomainParty({ partyType: 'agency', partyId: PARTY_ID });
    expect(log.info).not.toHaveBeenCalled();
  });

  it('emits DOMAIN_JOIN_OPTED_OUT with the resolved path ONLY when changed', async () => {
    mockLeaveDomainParty.mockResolvedValue({ path: 'request', changed: true });

    await leaveDomainParty({ partyType: 'company', partyId: PARTY_ID });

    expect(mockEmitOptedOut).toHaveBeenCalledWith('request', 'me-1');
  });

  it('does NOT emit analytics on a no-op (changed: false)', async () => {
    mockLeaveDomainParty.mockResolvedValue({ path: 'auto', changed: false });

    const result = await leaveDomainParty({ partyType: 'company', partyId: PARTY_ID });

    expect(result).toEqual({ success: true });
    expect(mockEmitOptedOut).not.toHaveBeenCalled();
  });

  it('rejects an invalid partyType', async () => {
    const result = await leaveDomainParty({
      partyType: 'nonsense' as 'company',
      partyId: PARTY_ID,
    });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockLeaveDomainParty).not.toHaveBeenCalled();
  });

  it('returns a friendly error when the orchestrator throws', async () => {
    mockLeaveDomainParty.mockRejectedValue(new Error('db down'));
    const result = await leaveDomainParty({ partyType: 'agency', partyId: PARTY_ID });
    expect(result).toEqual({
      success: false,
      error: 'Could not complete this action. Please try again.',
    });
  });
});
