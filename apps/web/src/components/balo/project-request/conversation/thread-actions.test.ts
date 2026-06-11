import { describe, it, expect } from 'vitest';
import { deriveThreadActions } from './thread-actions';
import { thread } from '@/test/fixtures/conversation';

describe('deriveThreadActions — call gating', () => {
  it('allows the call before kickoff on active threads, with lens-aware labels', () => {
    const client = deriveThreadActions({
      lens: 'client',
      requestStatus: 'eoi_submitted',
      thread: thread(),
      nudgeIsProposal: false,
    });
    expect(client.callAllowed).toBe(true);
    expect(client.callLabel).toBe('Book a call');
    expect(client.showCallOnRail).toBe(true);

    const expert = deriveThreadActions({
      lens: 'expert',
      requestStatus: 'eoi_submitted',
      thread: thread(),
      nudgeIsProposal: false,
    });
    expect(expert.callLabel).toBe('Propose times');
  });

  it('blocks the call at kickoff_approved and on non-active threads', () => {
    expect(
      deriveThreadActions({
        lens: 'client',
        requestStatus: 'kickoff_approved',
        thread: thread({ stage: 'won', relationshipStatus: 'accepted' }),
        nudgeIsProposal: false,
      }).callAllowed
    ).toBe(false);
    expect(
      deriveThreadActions({
        lens: 'client',
        requestStatus: 'accepted',
        thread: thread({ stage: 'not_selected' }),
        nudgeIsProposal: false,
      }).callAllowed
    ).toBe(false);
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
    expect(expert.headerProposal).toEqual({ kind: 'view', label: 'View submitted' });
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
    expect(actions.showCallOnRail).toBe(false);
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
