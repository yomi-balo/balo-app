import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  SIGNUP_DOMAIN_SERVER_EVENTS: {
    CLASSIFIED: 'signup_domain_classified',
  },
}));

import { emitSignupDomainClassified } from './signup-domain';

beforeEach(() => vi.clearAllMocks());

describe('emitSignupDomainClassified', () => {
  it('passes a corporate class straight through with the distinct_id', () => {
    emitSignupDomainClassified('corporate', 'u-1');
    expect(mockTrack).toHaveBeenCalledWith('signup_domain_classified', {
      domain_class: 'corporate',
      distinct_id: 'u-1',
    });
  });

  it('passes a freemail class straight through with the distinct_id', () => {
    emitSignupDomainClassified('freemail', 'u-2');
    expect(mockTrack).toHaveBeenCalledWith('signup_domain_classified', {
      domain_class: 'freemail',
      distinct_id: 'u-2',
    });
  });
});
