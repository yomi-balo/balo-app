import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { ThreadTabs } from './thread-tabs';
import { thread } from '@/test/fixtures/conversation';

const THREADS = [
  thread(),
  thread({
    relationshipId: 'rel-2',
    expertFirstName: 'Marcus',
    expertInitials: 'MC',
    unread: true,
  }),
];

describe('ThreadTabs', () => {
  it('renders tabs in the given (invite) order with the active one pressed', () => {
    render(
      <ThreadTabs
        threads={THREADS}
        activeThreadId="rel-1"
        showYouSuffix={false}
        onSelect={vi.fn()}
      />
    );
    const buttons = screen.getAllByRole('button');
    // textContent includes the (aria-hidden) avatar initials + sr-only labels.
    expect(buttons.map((b) => b.textContent)).toEqual(['PNPriya', 'MCMarcusUnread activity']);
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    expect(buttons[1]).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the unread dot (with an sr-only label) on unread threads only', () => {
    render(
      <ThreadTabs
        threads={THREADS}
        activeThreadId="rel-1"
        showYouSuffix={false}
        onSelect={vi.fn()}
      />
    );
    expect(screen.getAllByText('Unread activity')).toHaveLength(1);
  });

  it('fires onSelect with the relationship id', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ThreadTabs
        threads={THREADS}
        activeThreadId="rel-1"
        showYouSuffix={false}
        onSelect={onSelect}
      />
    );
    await user.click(screen.getByRole('button', { name: /Marcus/ }));
    expect(onSelect).toHaveBeenCalledWith('rel-2');
  });

  it('suffixes "(you)" on the expert lens', () => {
    render(
      <ThreadTabs threads={[thread()]} activeThreadId="rel-1" showYouSuffix onSelect={vi.fn()} />
    );
    expect(screen.getByText('(you)')).toBeInTheDocument();
  });
});
