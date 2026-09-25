import { describe, expect, it } from 'vitest';
import {
  LOBBY_MAX_CONSECUTIVE_POLL_FAILURES,
  LOBBY_POLL_BACKOFF_AFTER_MS,
  LOBBY_POLL_BACKOFF_INTERVAL_MS,
  LOBBY_POLL_INTERVAL_MS,
} from './lobby';
import {
  MEMBER_JOIN_EXHAUSTED_LINE,
  MEMBER_JOIN_MAX_ATTEMPTS,
  isRetryableMemberJoinFailure,
  memberJoinRetryDelayMs,
} from './member-join-retry';
import type { MemberJoinFailureReason } from './member-join-failure';

describe('memberJoinRetryDelayMs', () => {
  it('⚠ reuses the SHIPPED lobby cadence rather than inventing a second one', () => {
    expect(memberJoinRetryDelayMs(0, 0)).toBe(LOBBY_POLL_INTERVAL_MS);
    expect(memberJoinRetryDelayMs(1, LOBBY_POLL_BACKOFF_AFTER_MS)).toBe(
      LOBBY_POLL_BACKOFF_INTERVAL_MS
    );
  });

  it('backs off only after the shipped threshold', () => {
    expect(memberJoinRetryDelayMs(1, LOBBY_POLL_BACKOFF_AFTER_MS - 1)).toBe(LOBBY_POLL_INTERVAL_MS);
  });

  it('⚠ stops scheduling once the shipped failure budget is spent', () => {
    expect(MEMBER_JOIN_MAX_ATTEMPTS).toBe(LOBBY_MAX_CONSECUTIVE_POLL_FAILURES);
    expect(memberJoinRetryDelayMs(MEMBER_JOIN_MAX_ATTEMPTS - 1, 0)).not.toBeNull();
    expect(memberJoinRetryDelayMs(MEMBER_JOIN_MAX_ATTEMPTS, 0)).toBeNull();
    expect(memberJoinRetryDelayMs(MEMBER_JOIN_MAX_ATTEMPTS + 5, 0)).toBeNull();
  });

  it('offers a way forward rather than an apology when it gives up', () => {
    expect(MEMBER_JOIN_EXHAUSTED_LINE).toContain('try again');
    expect(MEMBER_JOIN_EXHAUSTED_LINE).toContain('head back');
  });

  it('⚠ promises no email — nothing sends one when a room becomes ready', () => {
    expect(MEMBER_JOIN_EXHAUSTED_LINE).not.toMatch(/email/i);
  });
});

describe('isRetryableMemberJoinFailure', () => {
  it.each<[MemberJoinFailureReason, boolean]>([
    ['outage', true],
    ['not_provisioned', true],
    ['not_open', false],
    ['account_refused', false],
    ['unavailable', false],
  ])('%s → %s', (reason, expected) => {
    expect(isRetryableMemberJoinFailure(reason)).toBe(expected);
  });
});
