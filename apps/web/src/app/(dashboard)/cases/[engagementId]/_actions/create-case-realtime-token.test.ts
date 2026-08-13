import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-421 — unit tests for the CASE conversation's Ably token endpoint.
 *
 * ⚠⚠ THE WHOLE POINT OF THIS SUITE IS THE MINTED CAPABILITY STRING. Everything else in the
 * action is plumbing; the capability is the only thing a tampered browser is actually held to.
 * Three properties are pinned separately because they fail separately:
 *
 *   1. SUBSCRIBE-ONLY — `['subscribe']`, never `['subscribe','publish']`. The server is the
 *      only publisher (`publishConversationEvent`), so a `publish` grant would let a client
 *      spoof a message into a thread it can merely read.
 *   2. EXACTLY ONE EXPLICIT CHANNEL — a case has one thread. A wildcard (`conversation:*`)
 *      would satisfy a naive "the right channel is in there" assertion while granting every
 *      thread on the platform, so the absence of `*` is asserted on the RAW string.
 *   3. THE CHANNEL COMES FROM THE **GATE** — the conversation id is never echoed from input.
 *      The fixture makes the gate's conversation id share no bytes with anything the caller
 *      sent, so "it named the right thread" cannot be satisfied by pass-through.
 *
 * ⚠ AND: there is NO writability check here, deliberately. A CLOSED case's thread is still
 * subscribed to — see the dedicated test at the bottom.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-00000000a001';
const USER_ID = 'u0000000-0000-4000-8000-00000000a002';
/**
 * ⚠ SHARES NO BYTES WITH THE INPUT. The action receives an `engagementId` and NOTHING else, so
 * a channel built from input would name `ENGAGEMENT_ID`; a channel built from the gate names
 * this. That is the entire cross-tenant property, made observable.
 */
const GATE_CONVERSATION_ID = 'd0000000-0000-4000-8000-00000000abeef';
/** Another tenant's thread. It must never appear in a capability minted for this caller. */
const OTHER_TENANT_CONVERSATION_ID = 'd0000000-0000-4000-8000-00000000a0ff';

vi.mock('server-only', () => ({}));

const mockRequireOnboardedUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  requireOnboardedUser: () => mockRequireOnboardedUser(),
}));

const mockResolveCaseAccess = vi.fn();
vi.mock('@/lib/cases/resolve-case-access', () => ({
  resolveCaseAccess: (...a: unknown[]) => mockResolveCaseAccess(...a),
}));

const mockIsConfigured = vi.fn();
const mockGetAblyRest = vi.fn();
const mockCreateTokenRequest = vi.fn();
vi.mock('@/lib/realtime/ably-server', () => ({
  isRealtimeConfigured: () => mockIsConfigured(),
  getAblyRest: () => mockGetAblyRest(),
}));

import { createCaseRealtimeTokenAction } from './create-case-realtime-token';
import { log } from '@/lib/logging';

/**
 * ⚠ DELIBERATELY THE MINIMUM THE ACTION READS: `conversationId`, and nothing else. The gate
 * resolves a much wider shape (lens, company, expert profile, status), and NONE of it reaches
 * the token — so a fixture carrying those fields would suggest they matter. `conversationWritable`
 * is here only so the closed-case test can flip it and show the answer is unchanged.
 */
const ACCESS = { conversationId: GATE_CONVERSATION_ID, conversationWritable: true };

const INPUT = { engagementId: ENGAGEMENT_ID };

const TOKEN = { keyName: 'k', mac: 'm', nonce: 'n', timestamp: 1, capability: '{}' };

interface TokenParams {
  clientId: string;
  ttl: number;
  capability: string;
}

function tokenParams(): TokenParams {
  const [call] = mockCreateTokenRequest.mock.calls;
  if (call === undefined) {
    throw new Error('expected a token request to have been minted');
  }
  const [params] = call as [TokenParams];
  return params;
}

function seed(): void {
  vi.clearAllMocks();
  mockRequireOnboardedUser.mockResolvedValue({ id: USER_ID });
  mockResolveCaseAccess.mockResolvedValue(ACCESS);
  mockIsConfigured.mockReturnValue(true);
  mockGetAblyRest.mockReturnValue({ auth: { createTokenRequest: mockCreateTokenRequest } });
  mockCreateTokenRequest.mockResolvedValue(TOKEN);
}

beforeEach(() => {
  seed();
});

describe('createCaseRealtimeTokenAction — the minted capability', () => {
  it('grants SUBSCRIBE ONLY, over EXACTLY ONE channel — the gate conversation', async () => {
    expect(await createCaseRealtimeTokenAction(INPUT)).toEqual({
      success: true,
      tokenRequest: TOKEN,
    });

    const parsed: unknown = JSON.parse(tokenParams().capability);
    // The channel name is restated as a LITERAL rather than built with
    // `conversationChannelName`: sharing the builder with production would make this pass
    // through any rename, and a renamed channel disconnects every live subscriber.
    expect(parsed).toEqual({ [`conversation:${GATE_CONVERSATION_ID}`]: ['subscribe'] });
    expect(Object.keys(parsed as Record<string, unknown>)).toHaveLength(1);
  });

  it('contains NO publish grant and NO wildcard ANYWHERE in the raw capability', async () => {
    await createCaseRealtimeTokenAction(INPUT);
    const { capability } = tokenParams();
    // Asserted on the RAW STRING, not the parsed object: a wildcard smuggled into either the
    // channel name or the operation list would still deep-equal "contains the right channel"
    // under a looser check, while granting the whole platform.
    expect(capability).not.toContain('publish');
    expect(capability).not.toContain('*');
  });

  /**
   * ⚠⚠ THE CROSS-TENANT PROPERTY. The caller supplies an engagement id and nothing else, so a
   * channel derived from input would name it. Only the gate's answer may reach the capability.
   */
  it('names the GATE conversation, never anything the caller sent', async () => {
    await createCaseRealtimeTokenAction(INPUT);
    const { capability } = tokenParams();
    expect(capability).toContain(GATE_CONVERSATION_ID);
    expect(capability).not.toContain(ENGAGEMENT_ID);
  });

  it('follows the gate when it resolves a DIFFERENT thread — the value is read, not cached', async () => {
    mockResolveCaseAccess.mockResolvedValue({
      ...ACCESS,
      conversationId: OTHER_TENANT_CONVERSATION_ID,
    });
    await createCaseRealtimeTokenAction(INPUT);
    expect(JSON.parse(tokenParams().capability)).toEqual({
      [`conversation:${OTHER_TENANT_CONVERSATION_ID}`]: ['subscribe'],
    });
  });

  it('attributes the connection to the SESSION user via clientId', async () => {
    await createCaseRealtimeTokenAction(INPUT);
    expect(tokenParams().clientId).toBe(USER_ID);
  });

  it('bounds post-revocation staleness with an explicit 15-minute TTL', async () => {
    await createCaseRealtimeTokenAction(INPUT);
    // ably-js re-runs the FULL gate through `authCallback` on refresh, so this number IS the
    // window in which a removed member keeps a live subscription.
    expect(tokenParams().ttl).toBe(900000);
  });
});

describe('createCaseRealtimeTokenAction — the gates, before any mint', () => {
  it('refuses an unauthenticated caller before the tenancy gate runs', async () => {
    mockRequireOnboardedUser.mockRejectedValue(new Error('Unauthorized'));
    expect(await createCaseRealtimeTokenAction(INPUT)).toEqual({
      success: false,
      error: 'You are not signed in.',
    });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockCreateTokenRequest).not.toHaveBeenCalled();
  });

  it('rejects a malformed engagementId before the tenancy gate runs', async () => {
    expect(await createCaseRealtimeTokenAction({ engagementId: 'nope' })).toEqual({
      success: false,
      error: 'Invalid request.',
    });
    expect(mockResolveCaseAccess).not.toHaveBeenCalled();
    expect(mockCreateTokenRequest).not.toHaveBeenCalled();
  });

  it('is STRICT — a caller-supplied conversationId is rejected, never honoured', async () => {
    // The one input that would break the whole model if it were accepted.
    const result = await createCaseRealtimeTokenAction({
      engagementId: ENGAGEMENT_ID,
      conversationId: OTHER_TENANT_CONVERSATION_ID,
    } as { engagementId: string });
    expect(result).toEqual({ success: false, error: 'Invalid request.' });
    expect(mockCreateTokenRequest).not.toHaveBeenCalled();
  });

  it('re-runs the FULL tenancy gate for the SESSION user on every mint', async () => {
    await createCaseRealtimeTokenAction(INPUT);
    expect(mockResolveCaseAccess).toHaveBeenCalledWith(ENGAGEMENT_ID, USER_ID);
  });

  it('denies (and warns) when the gate says no — and mints NOTHING', async () => {
    mockResolveCaseAccess.mockResolvedValue(null);
    expect(await createCaseRealtimeTokenAction(INPUT)).toEqual({
      success: false,
      error: 'You do not have access to this conversation.',
    });
    expect(log.warn).toHaveBeenCalledWith('Case realtime token denied', {
      engagementId: ENGAGEMENT_ID,
      userId: USER_ID,
    });
    expect(mockCreateTokenRequest).not.toHaveBeenCalled();
  });
});

describe('createCaseRealtimeTokenAction — graceful degradation', () => {
  it('returns the disabled flag (no toast material) when ABLY_API_KEY is unset', async () => {
    mockIsConfigured.mockReturnValue(false);
    expect(await createCaseRealtimeTokenAction(INPUT)).toEqual({ success: false, disabled: true });
    expect(mockCreateTokenRequest).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('Realtime disabled (no ABLY_API_KEY)', {
      engagementId: ENGAGEMENT_ID,
      userId: USER_ID,
    });
  });

  it('returns the disabled flag when the REST client is null despite a configured key', async () => {
    // The defensive arm: unreachable through `isRealtimeConfigured`, but it must degrade the
    // same way rather than throw a TypeError into the friendly-error catch.
    mockGetAblyRest.mockReturnValue(null);
    expect(await createCaseRealtimeTokenAction(INPUT)).toEqual({ success: false, disabled: true });
    expect(mockCreateTokenRequest).not.toHaveBeenCalled();
  });

  it('the disabled answer is DISTINCT from the denial answer', async () => {
    mockIsConfigured.mockReturnValue(false);
    const disabled = await createCaseRealtimeTokenAction(INPUT);

    seed();
    mockResolveCaseAccess.mockResolvedValue(null);
    const denied = await createCaseRealtimeTokenAction(INPUT);

    // `disabled` renders as a silent no-realtime island; a denial is a real error. Collapsing
    // them would hide an entitlement bug behind "realtime is off in this environment".
    expect(disabled).not.toEqual(denied);
  });

  it('maps a token-mint failure to friendly copy and logs the cause', async () => {
    mockCreateTokenRequest.mockRejectedValue(new Error('ably 500'));
    expect(await createCaseRealtimeTokenAction(INPUT)).toEqual({
      success: false,
      error: 'Could not connect live updates.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to create case realtime token',
      expect.objectContaining({ engagementId: ENGAGEMENT_ID, userId: USER_ID, error: 'ably 500' })
    );
  });
});

/**
 * ⚠⚠ NO WRITABILITY CHECK, AND THAT IS CORRECT. The token grants `subscribe` and never
 * `publish`, so a read-only thread and a live one need the SAME grant. Posting is refused by
 * `postCaseMessageAction`, which is the only writer. A "helpful" `conversationWritable` guard
 * added here would silently kill live updates on every closed case.
 */
describe('createCaseRealtimeTokenAction — a CLOSED case still gets a subscribe token', () => {
  it('mints for a non-writable thread, with the identical subscribe-only capability', async () => {
    mockResolveCaseAccess.mockResolvedValue({
      ...ACCESS,
      engagementStatus: 'completed',
      conversationWritable: false,
    });

    expect(await createCaseRealtimeTokenAction(INPUT)).toEqual({
      success: true,
      tokenRequest: TOKEN,
    });
    expect(JSON.parse(tokenParams().capability)).toEqual({
      [`conversation:${GATE_CONVERSATION_ID}`]: ['subscribe'],
    });
  });
});
