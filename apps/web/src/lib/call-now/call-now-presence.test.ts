import { describe, expect, it } from 'vitest';
import { callNowPresence } from './call-now-presence';

const CLIENT_BASE = {
  kind: 'client_terms',
  engagementId: 'e-1',
  expertProfileId: 'p-1',
  rateLine: null,
  inPlaceCandidate: null,
  bookInPage: true,
} as const;

describe('callNowPresence', () => {
  it('reports online and offline from the client read', () => {
    expect(callNowPresence({ ...CLIENT_BASE, calleeOnline: true })).toBe('online');
    expect(callNowPresence({ ...CLIENT_BASE, calleeOnline: false })).toBe('offline');
  });

  it('reports unknown on the expert arm, which is never shown the client’s presence', () => {
    expect(callNowPresence({ kind: 'expert_notice', engagementId: 'e-1' })).toBe('unknown');
  });

  it('reports unknown when there is no confirm', () => {
    expect(callNowPresence(null)).toBe('unknown');
  });
});
