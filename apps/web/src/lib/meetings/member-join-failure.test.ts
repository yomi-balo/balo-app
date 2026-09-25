import { describe, expect, it } from 'vitest';
import { memberJoinFailureReasonFor } from './member-join-failure';

describe('memberJoinFailureReasonFor — the allowlist', () => {
  it.each([
    [404, 'meeting_not_found', 'unavailable'],
    [409, 'meeting_not_open_for_join', 'not_open'],
    [409, 'meeting_not_provisioned', 'not_provisioned'],
    [503, 'meeting_token_unavailable', 'outage'],
    [500, 'Internal Server Error', 'outage'],
    [502, 'Bad Gateway', 'outage'],
    [504, 'Gateway Timeout', 'outage'],
    [0, 'request_failed', 'outage'],
    [401, 'account_suspended', 'account_refused'],
    [401, 'account_deleted', 'account_refused'],
    [401, 'unauthenticated', 'unavailable'],
    [401, 'Unauthorized', 'unavailable'],
    [429, 'rate_limited', 'unavailable'],
    [409, 'something_else', 'unavailable'],
    [400, 'invalid_request', 'unavailable'],
  ] as const)('(%i, %s) → %s', (status, code, expected) => {
    expect(memberJoinFailureReasonFor(status, code)).toBe(expected);
  });

  it('⚠ a 401 that merely LOOKS like a refusal code but is not exact still collapses', () => {
    expect(memberJoinFailureReasonFor(401, 'account_suspended_maybe')).toBe('unavailable');
  });

  it('⚠⚠ a 429 collapses even though the route has no rate limit today', () => {
    // Unreachable in production, but the allowlist rule must hold if that ever changes: 429 is
    // not distinguished from any other unrecognised status/code pair.
    expect(memberJoinFailureReasonFor(429, 'meeting_not_found')).toBe('unavailable');
  });
});
