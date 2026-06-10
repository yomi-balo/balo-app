import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import { MobileOverflowSheet, hasOverflowContent } from './mobile-overflow-sheet';
import { thread as baseThread } from '@/test/fixtures/conversation';
import type { ConversationThreadView } from '@/lib/project-request/conversation-view-types';

/** This suite's default thread carries a published profile slug. */
function thread(overrides: Partial<ConversationThreadView> = {}): ConversationThreadView {
  return baseThread({ expertUsername: 'priya-nair', ...overrides });
}

describe('hasOverflowContent', () => {
  it('is true only when a profile link or status pill exists (never a dead sheet)', () => {
    expect(hasOverflowContent({ profileHref: null, showProposalPill: false })).toBe(false);
    expect(hasOverflowContent({ profileHref: '/experts/x', showProposalPill: false })).toBe(true);
    expect(hasOverflowContent({ profileHref: null, showProposalPill: true })).toBe(true);
  });
});

describe('MobileOverflowSheet', () => {
  it('titles the sheet with the expert name and links to the public profile', () => {
    render(
      <MobileOverflowSheet
        open
        onOpenChange={vi.fn()}
        thread={thread()}
        showProposalPill={false}
        profileHref="/experts/priya-nair"
      />
    );
    expect(screen.getByText('Priya Nair')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View Priya's profile/ })).toHaveAttribute(
      'href',
      '/experts/priya-nair'
    );
  });

  it('closes the sheet when the profile link is followed', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const onOpenChange = vi.fn();
    render(
      <MobileOverflowSheet
        open
        onOpenChange={onOpenChange}
        thread={thread()}
        showProposalPill={false}
        profileHref="/experts/priya-nair"
      />
    );
    await user.click(screen.getByRole('link', { name: /View Priya's profile/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('omits the profile action when no username exists (no dead control)', () => {
    render(
      <MobileOverflowSheet
        open
        onOpenChange={vi.fn()}
        thread={thread({ expertUsername: null })}
        showProposalPill
        profileHref={null}
      />
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('Proposal requested — awaiting submission')).toBeInTheDocument();
  });

  it('hides the proposal pill when not requested', () => {
    render(
      <MobileOverflowSheet
        open
        onOpenChange={vi.fn()}
        thread={thread()}
        showProposalPill={false}
        profileHref="/experts/priya-nair"
      />
    );
    expect(screen.queryByText('Proposal requested — awaiting submission')).not.toBeInTheDocument();
  });
});
