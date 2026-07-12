import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', () => ({
  trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
  PARTY_JOIN_SERVER_EVENTS: {
    SIGNUP_DOMAIN_MATCHED: 'party_join_signup_domain_matched',
    DOMAIN_AUTO_JOIN_COMPLETED: 'party_join_domain_auto_join_completed',
    REQUEST_CREATED: 'party_join_request_created',
    REQUEST_APPROVED: 'party_join_request_approved',
    REQUEST_DECLINED: 'party_join_request_declined',
    DOMAIN_JOIN_OPTED_OUT: 'party_join_domain_opted_out',
    MODE_CHANGED: 'domain_join_mode_changed',
  },
  PARTY_DOMAIN_SERVER_EVENTS: {
    ADDED: 'party_domain_added',
    REMOVED: 'party_domain_removed',
  },
}));

import {
  emitSignupDomainMatched,
  emitAutoJoinCompleted,
  emitJoinRequestCreated,
  emitJoinRequestResolved,
  emitDomainJoinOptedOut,
  emitPartyDomainAdded,
  emitPartyDomainRemoved,
  emitDomainJoinModeChanged,
} from './party-join';

beforeEach(() => vi.clearAllMocks());

describe('party-join analytics wrappers', () => {
  it('emitSignupDomainMatched → party_type + mode + distinct_id', () => {
    emitSignupDomainMatched('company', 'auto', 'u-1');
    expect(mockTrack).toHaveBeenCalledWith('party_join_signup_domain_matched', {
      party_type: 'company',
      mode: 'auto',
      distinct_id: 'u-1',
    });
  });

  it('emitAutoJoinCompleted → party_type + distinct_id', () => {
    emitAutoJoinCompleted('agency', 'u-2');
    expect(mockTrack).toHaveBeenCalledWith('party_join_domain_auto_join_completed', {
      party_type: 'agency',
      distinct_id: 'u-2',
    });
  });

  it('emitJoinRequestCreated → party_type + distinct_id', () => {
    emitJoinRequestCreated('company', 'u-3');
    expect(mockTrack).toHaveBeenCalledWith('party_join_request_created', {
      party_type: 'company',
      distinct_id: 'u-3',
    });
  });

  it('emitJoinRequestResolved("approved") → REQUEST_APPROVED with requester distinct_id', () => {
    emitJoinRequestResolved('approved', {
      partyType: 'company',
      timeToResolutionSeconds: 42,
      requesterUserId: 'req-1',
    });
    expect(mockTrack).toHaveBeenCalledWith('party_join_request_approved', {
      party_type: 'company',
      time_to_resolution_seconds: 42,
      distinct_id: 'req-1',
    });
  });

  it('emitJoinRequestResolved("declined") → REQUEST_DECLINED', () => {
    emitJoinRequestResolved('declined', {
      partyType: 'agency',
      timeToResolutionSeconds: 7,
      requesterUserId: 'req-2',
    });
    expect(mockTrack).toHaveBeenCalledWith('party_join_request_declined', {
      party_type: 'agency',
      time_to_resolution_seconds: 7,
      distinct_id: 'req-2',
    });
  });

  it('emitDomainJoinOptedOut → path + distinct_id', () => {
    emitDomainJoinOptedOut('request', 'u-9');
    expect(mockTrack).toHaveBeenCalledWith('party_join_domain_opted_out', {
      path: 'request',
      distinct_id: 'u-9',
    });
  });

  // BAL-347 admin-settings wrappers

  it('emitPartyDomainAdded → party_domain_added with source admin_added', () => {
    emitPartyDomainAdded('company', 'admin_added', 'admin-1');
    expect(mockTrack).toHaveBeenCalledWith('party_domain_added', {
      party_type: 'company',
      source: 'admin_added',
      distinct_id: 'admin-1',
    });
  });

  it('emitPartyDomainAdded → carries the agency party_type', () => {
    emitPartyDomainAdded('agency', 'admin_added', 'admin-2');
    expect(mockTrack).toHaveBeenCalledWith('party_domain_added', {
      party_type: 'agency',
      source: 'admin_added',
      distinct_id: 'admin-2',
    });
  });

  it('emitPartyDomainRemoved → party_domain_removed + distinct_id', () => {
    emitPartyDomainRemoved('agency', 'admin-3');
    expect(mockTrack).toHaveBeenCalledWith('party_domain_removed', {
      party_type: 'agency',
      distinct_id: 'admin-3',
    });
  });

  it('emitDomainJoinModeChanged → domain_join_mode_changed with from + to', () => {
    emitDomainJoinModeChanged('auto', 'request', 'admin-4');
    expect(mockTrack).toHaveBeenCalledWith('domain_join_mode_changed', {
      from: 'auto',
      to: 'request',
      distinct_id: 'admin-4',
    });
  });
});
