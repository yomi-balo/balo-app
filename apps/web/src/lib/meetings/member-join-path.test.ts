import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { memberJoinPath } from './member-join-path';

// N9/N10 — `member-join-path.ts` had no test of its own. It is the ONE construction site for
// the member join route (`/join/m/{meetingId}`), and `book-consultation.ts` now calls it
// instead of building its own copy (N10) — a regression here would silently break both
// callers' `joinPath` at once.
describe('memberJoinPath', () => {
  it('returns exactly /join/m/{meetingId}', () => {
    expect(memberJoinPath('550e8400-e29b-41d4-a716-446655440000')).toBe(
      '/join/m/550e8400-e29b-41d4-a716-446655440000'
    );
  });

  it('never returns an absolute URL — always a same-origin path', () => {
    const path = memberJoinPath('550e8400-e29b-41d4-a716-446655440000');
    expect(path.startsWith('/')).toBe(true);
    expect(path.startsWith('//')).toBe(false);
    expect(path).not.toContain('://');
  });

  it('is a pure function of meetingId — no hidden state', () => {
    const a = memberJoinPath('11111111-1111-4111-8111-111111111111');
    const b = memberJoinPath('11111111-1111-4111-8111-111111111111');
    expect(a).toBe(b);
  });
});
