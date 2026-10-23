import { describe, it, expect } from 'vitest';
import { deriveThreadActions } from './thread-actions';
import { thread } from '@/test/fixtures/conversation';
import type { ProjectRequestStatus } from '@/lib/project-request/resolve-request-lens';

const NEXT = {
  meetingId: 'meeting-1',
  scheduledStartIso: '2026-09-01T04:00:00.000Z',
  contextType: 'request_interaction',
} as const;
const LATER = {
  meetingId: 'meeting-2',
  scheduledStartIso: '2026-09-02T04:00:00.000Z',
  contextType: 'request_interaction',
} as const;

const REQUEST_STATUSES: readonly ProjectRequestStatus[] = [
  'draft',
  'requested',
  'exploratory_meeting_requested',
  'experts_invited',
  'eoi_submitted',
  'proposal_requested',
  'proposal_submitted',
  'accepted',
  'kickoff_approved',
  'closed',
];

function slotFor(
  lens: 'client' | 'expert',
  requestStatus: ProjectRequestStatus,
  overrides: Parameters<typeof thread>[0] = {}
): ReturnType<typeof deriveThreadActions>['callSlot'] {
  return deriveThreadActions({
    lens,
    requestStatus,
    thread: thread(overrides),
    nudgeIsProposal: false,
  }).callSlot;
}

describe('deriveThreadActions — the callSlot state matrix (BAL-283, BAL-616)', () => {
  it('client, active thread, nothing upcoming → book in place', () => {
    expect(slotFor('client', 'eoi_submitted')).toEqual({ kind: 'book', route: 'in_place' });
  });

  it('client + EVERY request status: an active or won thread is always bookable in place', () => {
    for (const status of REQUEST_STATUSES) {
      for (const stage of ['active', 'won'] as const) {
        expect(slotFor('client', status, { stage, expertUsername: 'priya' })).toEqual({
          kind: 'book',
          route: 'in_place',
        });
        expect(slotFor('client', status, { stage, upcomingCalls: [NEXT, LATER] })).toEqual({
          kind: 'upcoming',
          next: NEXT,
          more: 1,
          canBookAnother: true,
        });
      }
    }
  });

  it('client at kickoff_approved on the won thread can still book another call (BAL-616)', () => {
    expect(
      slotFor('client', 'kickoff_approved', {
        stage: 'won',
        relationshipStatus: 'accepted',
        upcomingCalls: [NEXT],
      })
    ).toEqual({ kind: 'upcoming', next: NEXT, more: 0, canBookAnother: true });
  });

  it('client, thread the request moved on from → book via the expert profile', () => {
    for (const stage of ['not_selected', 'request_closed'] as const) {
      expect(slotFor('client', 'accepted', { stage, expertUsername: 'priya' })).toEqual({
        kind: 'book',
        route: 'profile',
      });
    }
  });

  it('a moved-on thread hides its upcoming calls and still routes to the profile', () => {
    expect(
      slotFor('client', 'accepted', {
        stage: 'not_selected',
        expertUsername: 'priya',
        upcomingCalls: [NEXT],
      })
    ).toEqual({ kind: 'book', route: 'profile' });
  });

  it('client, moved-on thread, expert has no public profile → none', () => {
    expect(slotFor('client', 'closed', { stage: 'request_closed', expertUsername: null })).toEqual({
      kind: 'none',
    });
  });

  it('expert, not yet shared → propose', () => {
    expect(slotFor('expert', 'eoi_submitted')).toEqual({ kind: 'propose' });
  });

  it('expert, availability_shared_at set → shared', () => {
    expect(
      slotFor('expert', 'eoi_submitted', { availabilitySharedAtIso: '2026-08-20T00:00:00.000Z' })
    ).toEqual({ kind: 'shared' });
  });

  it('client lens is UNAFFECTED by availabilitySharedAtIso', () => {
    expect(
      slotFor('client', 'eoi_submitted', { availabilitySharedAtIso: '2026-08-20T00:00:00.000Z' })
    ).toEqual({ kind: 'book', route: 'in_place' });
  });

  it('expert with an upcoming call sees it — never canBookAnother', () => {
    const slot = slotFor('expert', 'eoi_submitted', {
      upcomingCalls: [NEXT, LATER],
      availabilitySharedAtIso: '2026-08-20T00:00:00.000Z',
    });
    expect(slot).toEqual({ kind: 'upcoming', next: NEXT, more: 1, canBookAnother: false });
  });

  it('the expert lens never yields book, across every status and stage', () => {
    for (const status of REQUEST_STATUSES) {
      for (const stage of ['active', 'won', 'not_selected', 'request_closed'] as const) {
        const slot = slotFor('expert', status, { stage, expertUsername: 'priya' });
        expect(slot.kind).not.toBe('book');
        const withCalls = slotFor('expert', status, { stage, upcomingCalls: [NEXT] });
        expect(withCalls).not.toMatchObject({ canBookAnother: true });
      }
    }
  });

  it('expert: propose / shared only before kickoff on an active thread', () => {
    expect(slotFor('expert', 'kickoff_approved', { stage: 'won' })).toEqual({ kind: 'none' });
    expect(slotFor('expert', 'accepted', { stage: 'not_selected' })).toEqual({ kind: 'none' });
    expect(slotFor('expert', 'closed', { stage: 'request_closed' })).toEqual({ kind: 'none' });
    expect(slotFor('expert', 'kickoff_approved', { stage: 'active' })).toEqual({ kind: 'none' });
  });
});

describe('deriveThreadActions — header proposal slot', () => {
  it('client + relationship eoi_submitted → gradient Request proposal stub', () => {
    const actions = deriveThreadActions({
      lens: 'client',
      requestStatus: 'eoi_submitted',
      thread: thread(),
      nudgeIsProposal: false,
    });
    expect(actions.headerProposal).toEqual({
      kind: 'request',
      label: 'Request proposal',
      quiet: false,
    });
  });

  it('goes quiet when the nudge already pushes the proposal', () => {
    const actions = deriveThreadActions({
      lens: 'client',
      requestStatus: 'eoi_submitted',
      thread: thread(),
      nudgeIsProposal: true,
    });
    expect(actions.headerProposal).toMatchObject({ kind: 'request', quiet: true });
  });

  it('client + relationship proposal_requested → warning pill', () => {
    const actions = deriveThreadActions({
      lens: 'client',
      requestStatus: 'proposal_requested',
      thread: thread({ relationshipStatus: 'proposal_requested' }),
      nudgeIsProposal: false,
    });
    expect(actions.headerProposal).toEqual({ kind: 'pill-requested' });
  });

  it('expert + relationship eoi_submitted → awaiting pill', () => {
    const actions = deriveThreadActions({
      lens: 'expert',
      requestStatus: 'eoi_submitted',
      thread: thread(),
      nudgeIsProposal: false,
    });
    expect(actions.headerProposal).toEqual({ kind: 'pill-awaiting' });
  });

  it('expert + relationship proposal_requested → live Build proposal CTA (kind:build)', () => {
    const actions = deriveThreadActions({
      lens: 'expert',
      requestStatus: 'proposal_requested',
      thread: thread({ relationshipStatus: 'proposal_requested' }),
      nudgeIsProposal: false,
    });
    expect(actions.headerProposal).toEqual({
      kind: 'build',
      label: 'Build proposal',
      quiet: false,
    });
  });

  it('expert Build proposal goes quiet when the nudge already pushes the proposal', () => {
    const actions = deriveThreadActions({
      lens: 'expert',
      requestStatus: 'proposal_requested',
      thread: thread({ relationshipStatus: 'proposal_requested' }),
      nudgeIsProposal: true,
    });
    expect(actions.headerProposal).toMatchObject({ kind: 'build', quiet: true });
  });

  it('relationship ≥ proposal_submitted → lens-aware View stub', () => {
    const client = deriveThreadActions({
      lens: 'client',
      requestStatus: 'proposal_submitted',
      thread: thread({ relationshipStatus: 'proposal_submitted' }),
      nudgeIsProposal: false,
    });
    expect(client.headerProposal).toEqual({ kind: 'view', label: 'View proposal' });

    const expert = deriveThreadActions({
      lens: 'expert',
      requestStatus: 'proposal_submitted',
      thread: thread({ relationshipStatus: 'proposal_submitted' }),
      nudgeIsProposal: false,
    });
    expect(expert.headerProposal).toEqual({ kind: 'view', label: 'View submitted proposal' });
  });

  it('open change request: the expert gets a live Revise CTA; the client keeps View proposal', () => {
    const revising = thread({
      relationshipStatus: 'proposal_submitted',
      changeRequest: {
        requestedBy: 'Dana @ Northwind',
        notePreview: 'More detail',
        nextVersion: 2,
      },
    });

    const expert = deriveThreadActions({
      lens: 'expert',
      requestStatus: 'proposal_submitted',
      thread: revising,
      nudgeIsProposal: false,
    });
    expect(expert.headerProposal).toEqual({
      kind: 'build',
      label: 'Revise proposal',
      quiet: false,
    });
    expect(expert.railProposal).toEqual({ kind: 'build', label: 'Revise proposal', quiet: false });

    const client = deriveThreadActions({
      lens: 'client',
      requestStatus: 'proposal_submitted',
      thread: revising,
      nudgeIsProposal: false,
    });
    expect(client.headerProposal).toEqual({ kind: 'view', label: 'View proposal' });
    expect(client.railProposal).toEqual({ kind: 'view', label: 'View proposal', quiet: false });
  });

  it('hides the slot entirely once the call gate closes', () => {
    const actions = deriveThreadActions({
      lens: 'client',
      requestStatus: 'kickoff_approved',
      thread: thread({ stage: 'won', relationshipStatus: 'accepted' }),
      nudgeIsProposal: false,
    });
    expect(actions.headerProposal).toBeNull();
  });
});

describe('deriveThreadActions — mobile rail', () => {
  it('collapses entirely past acceptance', () => {
    const actions = deriveThreadActions({
      lens: 'client',
      requestStatus: 'accepted',
      thread: thread({ stage: 'won', relationshipStatus: 'accepted' }),
      nudgeIsProposal: false,
    });
    expect(actions.callSlot).toEqual({ kind: 'book', route: 'in_place' });
    expect(actions.railProposal).toBeNull();
  });

  it('client not-yet-requested → live Request proposal; submitted → View proposal STUB', () => {
    expect(
      deriveThreadActions({
        lens: 'client',
        requestStatus: 'eoi_submitted',
        thread: thread(),
        nudgeIsProposal: false,
      }).railProposal
    ).toEqual({ kind: 'request', label: 'Request proposal', quiet: false });
    // kind:'view' — A6's CTA; the rail must render it disabled, never wire it
    // to the A5 request flow.
    expect(
      deriveThreadActions({
        lens: 'client',
        requestStatus: 'proposal_submitted',
        thread: thread({ relationshipStatus: 'proposal_submitted' }),
        nudgeIsProposal: false,
      }).railProposal
    ).toEqual({ kind: 'view', label: 'View proposal', quiet: false });
  });

  it('expert requested-not-submitted → live Build proposal (kind:build)', () => {
    expect(
      deriveThreadActions({
        lens: 'expert',
        requestStatus: 'proposal_requested',
        thread: thread({ relationshipStatus: 'proposal_requested' }),
        nudgeIsProposal: false,
      }).railProposal
    ).toEqual({ kind: 'build', label: 'Build proposal', quiet: false });
  });
});

describe('deriveThreadActions — declineSlot (BAL-540)', () => {
  it('defaults to null when canDecline is omitted (every pre-existing call site)', () => {
    const actions = deriveThreadActions({
      lens: 'client',
      requestStatus: 'eoi_submitted',
      thread: thread(),
      nudgeIsProposal: false,
    });
    expect(actions.declineSlot).toBeNull();
  });

  it('is null when canDecline is false even on an active thread', () => {
    const actions = deriveThreadActions({
      lens: 'client',
      requestStatus: 'eoi_submitted',
      thread: thread({ stage: 'active' }),
      nudgeIsProposal: false,
      canDecline: false,
    });
    expect(actions.declineSlot).toBeNull();
  });

  it('is the relationship status (as a TrackStage) when canDecline is true AND the thread is active', () => {
    const actions = deriveThreadActions({
      lens: 'client',
      requestStatus: 'eoi_submitted',
      thread: thread({ stage: 'active', relationshipStatus: 'eoi_submitted' }),
      nudgeIsProposal: false,
      canDecline: true,
    });
    expect(actions.declineSlot).toBe('eoi_submitted');
  });

  it('is null once the thread is decided (won / not_selected / request_closed), even with canDecline true', () => {
    for (const stage of ['won', 'not_selected', 'request_closed'] as const) {
      const actions = deriveThreadActions({
        lens: 'client',
        requestStatus: 'accepted',
        thread: thread({ stage, relationshipStatus: 'accepted' }),
        nudgeIsProposal: false,
        canDecline: true,
      });
      expect(actions.declineSlot).toBeNull();
    }
  });
});
