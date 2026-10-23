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

function renderNudge(
  content: ThreadNudgeContent,
  onBuild?: () => void
): {
  onReply: ReturnType<typeof vi.fn>;
  onCall: ReturnType<typeof vi.fn>;
} {
  const onReply = vi.fn();
  const onCall = vi.fn();
  render(
    <ThreadNudge
      nudge={content}
      callPending={false}
      onReply={onReply}
      onCall={onCall}
      onBuild={onBuild}
    />
  );
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

  it('renders a link primary as a navigation with the solid primary class', () => {
    renderNudge(
      nudge({
        variant: 'done',
        primary: {
          label: 'Open project workspace',
          icon: Calendar,
          action: 'link',
          href: '/engagements/eng-1?from=request_detail',
        },
        secondary: undefined,
      })
    );
    const link = screen.getByRole('link', { name: 'Open project workspace' });
    expect(link).toHaveAttribute('href', '/engagements/eng-1?from=request_detail');
    expect(link.className).toContain('bg-primary');
    expect(link.className).toContain('text-primary-foreground');
    expect(link.className).not.toContain('bg-gradient-to-r');
  });

  it('renders the event variant as a status marker with no eyebrow, button or link', () => {
    renderNudge(
      nudge({
        variant: 'event',
        headline: 'You chose Priya for this project',
        sub: undefined,
        primary: undefined,
        secondary: undefined,
      })
    );
    expect(screen.getByRole('status')).toHaveTextContent('You chose Priya for this project');
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting')).not.toBeInTheDocument();
    expect(screen.queryByText('Your next step')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders no action row when the only button has no handler', () => {
    const { container } = render(
      <ThreadNudge
        nudge={nudge({
          variant: 'commit',
          primary: { label: "Accept Priya's proposal", icon: Calendar, action: 'accept' },
          secondary: undefined,
        })}
        callPending={false}
        onReply={vi.fn()}
        onCall={vi.fn()}
      />
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container.querySelector('.mt-2\\.5')).toBeNull();
  });

  it('wires the build primary to onBuild when provided (A6.2)', async () => {
    const user = userEvent.setup();
    const onBuild = vi.fn();
    renderNudge(
      nudge({
        headline: 'The client requested your proposal — build it',
        primary: { label: 'Build proposal', icon: Calendar, action: 'build' },
        secondary: undefined,
      }),
      onBuild
    );
    const cta = screen.getByRole('button', { name: 'Build proposal' });
    expect(cta).toBeEnabled();
    await user.click(cta);
    expect(onBuild).toHaveBeenCalledTimes(1);
  });

  it('renders no build button when no onBuild handler is provided', () => {
    renderNudge(
      nudge({
        primary: { label: 'Build proposal', icon: Calendar, action: 'build' },
        secondary: undefined,
      })
    );
    expect(screen.queryByRole('button', { name: 'Build proposal' })).not.toBeInTheDocument();
  });

  it('wires the accept primary and view secondary to onAccept/onView', async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    const onView = vi.fn();
    render(
      <ThreadNudge
        nudge={nudge({
          variant: 'commit',
          primary: { label: "Accept Priya's proposal", icon: Calendar, action: 'accept' },
          secondary: { label: 'View full proposal', icon: Calendar, action: 'view' },
        })}
        callPending={false}
        onReply={vi.fn()}
        onCall={vi.fn()}
        onAccept={onAccept}
        onView={onView}
      />
    );
    await user.click(screen.getByRole('button', { name: "Accept Priya's proposal" }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'View full proposal' }));
    expect(onView).toHaveBeenCalledTimes(1);
  });

  it('renders no accept button when no onAccept handler is provided', () => {
    renderNudge(
      nudge({
        variant: 'commit',
        primary: { label: "Accept Priya's proposal", icon: Calendar, action: 'accept' },
        secondary: undefined,
      })
    );
    expect(
      screen.queryByRole('button', { name: "Accept Priya's proposal" })
    ).not.toBeInTheDocument();
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
