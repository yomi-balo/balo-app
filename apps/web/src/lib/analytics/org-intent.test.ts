import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  ORG_INTENT_SERVER_EVENTS: {
    CREATED_AT_INTENT: 'org_created_at_intent',
  },
}));

import { emitOrgCreatedAtIntent } from './org-intent';

beforeEach(() => vi.clearAllMocks());

describe('emitOrgCreatedAtIntent', () => {
  it('emits a company + corporate org-intent with the distinct_id', () => {
    emitOrgCreatedAtIntent('company', 'corporate', 'u-1');
    expect(mockTrack).toHaveBeenCalledWith('org_created_at_intent', {
      party_type: 'company',
      domain_class: 'corporate',
      distinct_id: 'u-1',
    });
  });

  it('emits an agency + freemail org-intent with the distinct_id', () => {
    emitOrgCreatedAtIntent('agency', 'freemail', 'u-2');
    expect(mockTrack).toHaveBeenCalledWith('org_created_at_intent', {
      party_type: 'agency',
      domain_class: 'freemail',
      distinct_id: 'u-2',
    });
  });
});
