import { describe, it, expect } from 'vitest';
import { threadNudgeFor } from './thread-nudge-content';
import { thread as baseThread } from '@/test/fixtures/conversation';
import type { ConversationThreadView } from './conversation-view-types';

/** This suite's default thread carries fresh inbound activity. */
function thread(overrides: Partial<ConversationThreadView> = {}): ConversationThreadView {
  return baseThread({
    latestMessagePreview: 'Quick question about CPQ scope',
    latestMessageAtIso: '2026-06-09T00:00:00.000Z',
    latestInboundActivityAtIso: '2026-06-09T00:00:00.000Z',
    ...overrides,
  });
}

describe('threadNudgeFor — client lens', () => {
  it('eoi_submitted + unread → reply nudge with the latest message and a composer placeholder', () => {
    const nudge = threadNudgeFor('client', 'eoi_submitted', thread({ unread: true }));
    expect(nudge?.variant).toBe('action');
    expect(nudge?.headline).toBe('Priya sent a message — reply to keep momentum');
    expect(nudge?.sub).toBe('Quick question about CPQ scope');
    expect(nudge?.composerPlaceholder).toBe('Reply to Priya…');
    expect(nudge?.primary).toBeUndefined();
  });

  it('keeps the reply nudge after the dot clears while the latest message is inbound', () => {
    const nudge = threadNudgeFor(
      'client',
      'eoi_submitted',
      thread({ unread: false, latestMessageFromViewer: false })
    );
    expect(nudge?.headline).toBe('Priya sent a message — reply to keep momentum');
  });

  it('eoi_submitted + replied → meet nudge with call primary and reply secondary', () => {
    const nudge = threadNudgeFor(
      'client',
      'eoi_submitted',
      thread({ latestMessageFromViewer: true })
    );
    expect(nudge?.headline).toBe("Meet Priya — they're keen to help");
    expect(nudge?.primary).toMatchObject({ label: 'Book a call with Priya', action: 'call' });
    expect(nudge?.secondary).toMatchObject({ label: 'Reply by message', action: 'reply' });
  });

  it('eoi_submitted with no messages yet → meet nudge', () => {
    const nudge = threadNudgeFor(
      'client',
      'eoi_submitted',
      thread({ latestMessagePreview: null, latestMessageAtIso: null })
    );
    expect(nudge?.headline).toBe("Meet Priya — they're keen to help");
  });

  it('relationship proposal_requested → waiting with reply secondary', () => {
    const nudge = threadNudgeFor(
      'client',
      'proposal_requested',
      thread({ relationshipStatus: 'proposal_requested' })
    );
    expect(nudge?.variant).toBe('waiting');
    expect(nudge?.headline).toBe('Priya is preparing the proposal');
    expect(nudge?.secondary?.action).toBe('reply');
  });

  it('relationship proposal_submitted → commit with stubbed accept/view CTAs', () => {
    const nudge = threadNudgeFor(
      'client',
      'proposal_submitted',
      thread({ relationshipStatus: 'proposal_submitted' })
    );
    expect(nudge?.variant).toBe('commit');
    expect(nudge?.headline).toBe("Priya's proposal is ready");
    expect(nudge?.primary).toMatchObject({ label: "Accept Priya's proposal", action: 'stub' });
    expect(nudge?.secondary).toMatchObject({ label: 'View full proposal', action: 'stub' });
  });

  it('BAL-272 divergence: thread B stays on the meet/reply cell while thread A is requested', () => {
    // The REQUEST advanced to proposal_requested via expert A; expert B's thread
    // is still eoi_submitted — B must NOT read "B is preparing the proposal".
    const nudge = threadNudgeFor(
      'client',
      'proposal_requested',
      thread({ relationshipStatus: 'eoi_submitted', latestMessageFromViewer: true })
    );
    expect(nudge?.headline).toBe("Meet Priya — they're keen to help");
  });

  it('accepted + not_selected → gracious records copy, no CTAs', () => {
    const nudge = threadNudgeFor('client', 'accepted', thread({ stage: 'not_selected' }));
    expect(nudge?.variant).toBe('done');
    expect(nudge?.headline).toBe("You didn't select Priya");
    expect(nudge?.primary).toBeUndefined();
    expect(nudge?.secondary).toBeUndefined();
  });

  it('accepted + won → workspace stub', () => {
    const nudge = threadNudgeFor('client', 'kickoff_approved', thread({ stage: 'won' }));
    expect(nudge?.headline).toBe('Priya is your expert');
    expect(nudge?.primary).toMatchObject({ label: 'Open project workspace', action: 'stub' });
  });
});

describe('threadNudgeFor — expert lens', () => {
  it('eoi_submitted → propose times (call) + send message (reply)', () => {
    const nudge = threadNudgeFor('expert', 'eoi_submitted', thread());
    expect(nudge?.headline).toBe('Offer the client a time to talk');
    expect(nudge?.primary).toMatchObject({ label: 'Propose meeting times', action: 'call' });
    expect(nudge?.secondary).toMatchObject({ label: 'Send a message', action: 'reply' });
  });

  it('relationship proposal_requested → live build proposal CTA (A6.2)', () => {
    const nudge = threadNudgeFor(
      'expert',
      'proposal_requested',
      thread({ relationshipStatus: 'proposal_requested' })
    );
    expect(nudge?.headline).toBe('The client requested your proposal — build it');
    expect(nudge?.primary).toMatchObject({ label: 'Build proposal', action: 'build' });
    expect(nudge?.sub).toBe(
      'Lay out scope, milestones and pricing. You can save a draft and submit when ready.'
    );
  });

  it('relationship proposal_submitted → waiting with reply secondary', () => {
    const nudge = threadNudgeFor(
      'expert',
      'proposal_submitted',
      thread({ relationshipStatus: 'proposal_submitted' })
    );
    expect(nudge?.variant).toBe('waiting');
    expect(nudge?.secondary?.action).toBe('reply');
  });

  it('BAL-272 divergence: a non-requested expert NEVER sees the build prompt', () => {
    // Request status advanced via another expert's thread; this expert's own
    // relationship is still eoi_submitted → keep the propose-times cell.
    const nudge = threadNudgeFor(
      'expert',
      'proposal_requested',
      thread({ relationshipStatus: 'eoi_submitted' })
    );
    expect(nudge?.headline).toBe('Offer the client a time to talk');
  });

  it('accepted (won) → confirm payment terms stub', () => {
    const nudge = threadNudgeFor('expert', 'accepted', thread({ stage: 'won' }));
    expect(nudge?.headline).toBe('Confirm payment terms for kickoff');
    expect(nudge?.primary?.action).toBe('stub');
  });

  it('kickoff_approved (won) → done workspace stub', () => {
    const nudge = threadNudgeFor('expert', 'kickoff_approved', thread({ stage: 'won' }));
    expect(nudge?.variant).toBe('done');
    expect(nudge?.headline).toBe('Kicked off — time to deliver');
  });

  it('not_selected wins over any status → records copy, no CTAs', () => {
    const nudge = threadNudgeFor('expert', 'accepted', thread({ stage: 'not_selected' }));
    expect(nudge?.variant).toBe('done');
    expect(nudge?.headline).toBe('The client went with another expert');
    expect(nudge?.primary).toBeUndefined();
  });
});
