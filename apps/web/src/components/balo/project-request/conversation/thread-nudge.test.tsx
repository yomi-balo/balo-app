import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { Calendar, MessageSquare } from 'lucide-react';
import { ThreadNudge } from './thread-nudge';
import type { ThreadNudgeContent } from '@/lib/project-request/thread-nudge-content';

function nudge(overrides: Partial<ThreadNudgeContent> = {}): ThreadNudgeContent {
  return {
    variant: 'action',
    icon: Calendar,
    headline: "Meet Priya — they're keen to help",
    sub: 'A quick intro call is the fastest way to gauge fit.',
    primary: { label: 'Book a call with Priya', icon: Calendar, action: 'call' },
    secondary: { label: 'Reply by message', icon: MessageSquare, action: 'reply' },
    ...overrides,
  };
}

function renderNudge(content: ThreadNudgeContent): {
  onReply: ReturnType<typeof vi.fn>;
  onCall: ReturnType<typeof vi.fn>;
} {
  const onReply = vi.fn();
  const onCall = vi.fn();
  render(<ThreadNudge nudge={content} callPending={false} onReply={onReply} onCall={onCall} />);
  return { onReply, onCall };
}

describe('ThreadNudge', () => {
  it('renders the eyebrow, headline, and sub', () => {
    renderNudge(nudge());
    expect(screen.getByText('Your next step')).toBeInTheDocument();
    expect(screen.getByText("Meet Priya — they're keen to help")).toBeInTheDocument();
    expect(screen.getByText(/quick intro call/)).toBeInTheDocument();
  });

  it('wires the call primary and the reply secondary', async () => {
    const user = userEvent.setup();
    const { onReply, onCall } = renderNudge(nudge());
    await user.click(screen.getByRole('button', { name: 'Book a call with Priya' }));
    expect(onCall).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reply by message' }));
    expect(onReply).toHaveBeenCalled();
  });

  it('renders stub CTAs disabled (A5/A6 own them)', () => {
    renderNudge(
      nudge({
        variant: 'commit',
        primary: { label: "Accept Priya's proposal", icon: Calendar, action: 'stub' },
        secondary: undefined,
      })
    );
    expect(screen.getByText('Your next step')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Accept Priya's proposal" })).toBeDisabled();
  });

  it('uses the waiting/done eyebrows for those variants', () => {
    const { rerender } = render(
      <ThreadNudge
        nudge={nudge({ variant: 'waiting', primary: undefined, secondary: undefined })}
        callPending={false}
        onReply={vi.fn()}
        onCall={vi.fn()}
      />
    );
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    rerender(
      <ThreadNudge
        nudge={nudge({ variant: 'done', primary: undefined, secondary: undefined })}
        callPending={false}
        onReply={vi.fn()}
        onCall={vi.fn()}
      />
    );
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  it('disables the call CTA while the mock action is pending', () => {
    render(<ThreadNudge nudge={nudge()} callPending onReply={vi.fn()} onCall={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Book a call with Priya' })).toBeDisabled();
    // Reply is unaffected.
    expect(screen.getByRole('button', { name: 'Reply by message' })).toBeEnabled();
  });
});
