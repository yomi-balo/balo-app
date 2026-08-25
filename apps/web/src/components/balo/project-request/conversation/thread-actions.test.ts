import { describe, it, expect } from 'vitest';
import { deriveThreadActions } from './thread-actions';
import { thread } from '@/test/fixtures/conversation';

describe('deriveThreadActions — the callSlot state matrix (BAL-283)', () => {
  it('client, nothing booked yet → book', () => {
    const client = deriveThreadActions({
      lens: 'client',
      requestStatus: 'eoi_submitted',
      thread: thread(),
      nudgeIsProposal: false,
    });
    expect(client.callSlot).toEqual({ kind: 'book' });
  });

  it('expert, not yet shared → propose', () => {
    const expert = deriveThreadActions({
      lens: 'expert',
      requestStatus: 'eoi_submitted',
      thread: thread(),
      nudgeIsProposal: false,
    });
    expect(expert.callSlot).toEqual({ kind: 'propose' });
  });

  it('expert, availability_shared_at set → shared', () => {
    const expert = deriveThreadActions({
      lens: 'expert',
      requestStatus: 'eoi_submitted',
      thread: thread({ availabilitySharedAtIso: '2026-08-20T00:00:00.000Z' }),
      nudgeIsProposal: false,
    });
    expect(expert.callSlot).toEqual({ kind: 'shared' });
  });

  it('client lens is UNAFFECTED by availabilitySharedAtIso — it stays "book"', () => {
    const client = deriveThreadActions({
      lens: 'client',
      requestStatus: 'eoi_submitted',
      thread: thread({ availabilitySharedAtIso: '2026-08-20T00:00:00.000Z' }),
      nudgeIsProposal: false,
    });
    expect(client.callSlot).toEqual({ kind: 'book' });
  });

  it('either lens, a live call is booked → booked, with the scheduled start — BEATS everything', () => {
    const bookedCall = { meetingId: 'meeting-1', scheduledStartIso: '2026-09-01T04:00:00.000Z' };
    const client = deriveThreadActions({
      lens: 'client',
      requestStatus: 'eoi_submitted',
      thread: thread({ bookedCall }),
      nudgeIsProposal: false,
    });
    expect(client.callSlot).toEqual({
      kind: 'booked',
      scheduledStartIso: bookedCall.scheduledStartIso,
    });

    const expert = deriveThreadActions({
      lens: 'expert',
      requestStatus: 'eoi_submitted',
      thread: thread({ bookedCall, availabilitySharedAtIso: '2026-08-20T00:00:00.000Z' }),
      nudgeIsProposal: false,
    });
    expect(expert.callSlot).toEqual({
      kind: 'booked',
      scheduledStartIso: bookedCall.scheduledStartIso,
    });
  });

  it('blocks the call (kind: none) at kickoff_approved and on non-active threads', () => {
    expect(
      deriveThreadActions({
        lens: 'client',
        requestStatus: 'kickoff_approved',
        thread: thread({ stage: 'won', relationshipStatus: 'accepted' }),
        nudgeIsProposal: false,
      }).callSlot
    ).toEqual({ kind: 'none' });
    expect(
      deriveThreadActions({
        lens: 'client',
        requestStatus: 'accepted',
        thread: thread({ stage: 'not_selected' }),
        nudgeIsProposal: false,
      }).callSlot
    ).toEqual({ kind: 'none' });
  });

  it('a booked call still wins even past the call gate (nothing left to re-derive)', () => {
    const bookedCall = { meetingId: 'meeting-1', scheduledStartIso: '2026-09-01T04:00:00.000Z' };
    const actions = deriveThreadActions({
      lens: 'client',
      requestStatus: 'kickoff_approved',
      thread: thread({ stage: 'won', relationshipStatus: 'accepted', bookedCall }),
      nudgeIsProposal: false,
    });
    expect(actions.callSlot).toEqual({
      kind: 'booked',
      scheduledStartIso: bookedCall.scheduledStartIso,
    });
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
    expect(actions.callSlot).toEqual({ kind: 'none' });
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
