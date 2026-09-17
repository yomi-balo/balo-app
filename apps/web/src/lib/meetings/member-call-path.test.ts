import { describe, expect, it } from 'vitest';
import { memberCallPath } from './member-call-path';
import { isMeetingCallPath } from './is-meeting-call-path';

describe('memberCallPath (BAL-566 fix round 1, F1)', () => {
  it('builds the authenticated member call route', () => {
    expect(memberCallPath('0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d')).toBe(
      '/meetings/0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d/call'
    );
  });

  it('never builds the anonymous lobby path', () => {
    expect(memberCallPath('abc')).not.toContain('/join/');
  });

  it('round-trips with isMeetingCallPath, so the builder and the predicate cannot drift apart', () => {
    expect(isMeetingCallPath(memberCallPath('abc'))).toBe(true);
    expect(isMeetingCallPath(memberCallPath('0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d'))).toBe(true);
  });
});
