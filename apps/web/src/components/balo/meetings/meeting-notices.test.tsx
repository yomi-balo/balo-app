import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import {
  CALL_ENDED_TITLE,
  CALL_LEFT_BODY,
  CALL_LEFT_TITLE,
  MeetingAnnouncer,
  MeetingEndedNotice,
  MeetingPill,
  PresentingBar,
  RECONNECTING_BODY,
  RECONNECTING_LONG_BODY,
  RECONNECTING_TITLE,
  ReconnectingOverlay,
} from './meeting-notices';

/**
 * BAL-435 — the frame's notices.
 *
 * ⚠⚠ TWO OF THESE ARE NOT DECORATION:
 *
 *   · {@link MeetingAnnouncer} is the ONLY thing on this surface that tells a screen-reader user
 *     anything changed. The reconnect overlay's spinner is `aria-hidden` and stops moving
 *     entirely under `prefers-reduced-motion`, so without the live region a person whose
 *     connection dropped got silence, and silence again on recovery.
 *   · {@link MeetingEndedNotice} is the TERMINAL state, and it is a security control: the frame
 *     used to fall back to PreJoin's live "Join now" after an eject, with the same still-valid
 *     token. It must offer no rejoin affordance of any kind.
 */

describe('ReconnectingOverlay', () => {
  it('states the situation IN WORDS — the spinner is never the message', () => {
    // `motion-reduce:animate-none` means the spinner may not move at all.
    render(<ReconnectingOverlay isLongWait={false} onLeave={vi.fn()} />);

    expect(screen.getByText(RECONNECTING_TITLE)).toBeInTheDocument();
    expect(screen.getByText(RECONNECTING_BODY)).toBeInTheDocument();
  });

  it('offers no way out early — the call may recover in 800ms', () => {
    render(<ReconnectingOverlay isLongWait={false} onLeave={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Leave the call' })).toBeNull();
  });

  it('⚠ after a long wait the copy changes and a way out appears', async () => {
    const onLeave = vi.fn();
    const user = userEvent.setup();
    render(<ReconnectingOverlay isLongWait onLeave={onLeave} />);

    expect(screen.getByText(RECONNECTING_LONG_BODY)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Leave the call' }));

    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('promises the place is held rather than implying "any second now"', () => {
    render(<ReconnectingOverlay isLongWait onLeave={vi.fn()} />);

    expect(RECONNECTING_LONG_BODY).toMatch(/nobody has to let you back in/i);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<ReconnectingOverlay isLongWait onLeave={vi.fn()} />);

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('MeetingPill', () => {
  it('⚠ is an <output>, not role="status" (SonarCloud S6819), and carries no aria-busy', () => {
    const { container } = render(<MeetingPill message="Joined with your usual mic and camera." />);

    expect(container.querySelector('output')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelectorAll('[aria-busy]')).toHaveLength(0);
  });

  it('renders its action only when both the label and the handler are present', async () => {
    const onAction = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<MeetingPill message="Devices changed" />);

    expect(screen.queryByRole('button')).toBeNull();

    rerender(
      <MeetingPill message="Devices changed" actionLabel="Change devices" onAction={onAction} />
    );
    await user.click(screen.getByRole('button', { name: 'Change devices' }));

    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('takes a warning tone without changing the element', () => {
    const { container } = render(<MeetingPill message="Blocked" tone="warning" />);

    expect(container.querySelector('output')?.className).toContain('warning');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <MeetingPill message="Blocked" actionLabel="Show me how" onAction={vi.fn()} />
    );

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('PresentingBar', () => {
  it('says who is presenting and offers the stop', async () => {
    const onStop = vi.fn();
    const user = userEvent.setup();
    render(<PresentingBar onStop={onStop} />);

    expect(screen.getByText(/you.?re presenting/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop sharing' }));

    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('keeps the stop control above the 44px floor', () => {
    const { container } = render(<PresentingBar onStop={vi.fn()} />);

    expect(container.querySelector('button')?.className).toContain('min-h-11');
  });
});

describe('MeetingAnnouncer — ⚠⚠ §16, the one polite live region', () => {
  it('is a polite <output>, never role="status" and never aria-busy', () => {
    const { container } = render(<MeetingAnnouncer message="You are muted." />);

    const region = container.querySelector('output');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.getAttribute('aria-busy')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('⚠ is visually hidden — it announces, it does not decorate', () => {
    const { container } = render(<MeetingAnnouncer message="You are muted." />);

    expect(container.querySelector('output')?.className).toContain('sr-only');
  });

  it('renders whatever the frame last decided to say', () => {
    const { rerender, container } = render(<MeetingAnnouncer message="" />);
    expect(container.querySelector('output')?.textContent).toBe('');

    rerender(<MeetingAnnouncer message="Someone joined the call." />);
    expect(container.querySelector('output')?.textContent).toBe('Someone joined the call.');
  });
});

describe('MeetingEndedNotice — ⚠⚠ the terminal state', () => {
  it('⚠⚠ offers NO rejoin affordance of any kind, on either reason', () => {
    // ⚠ THE SECURITY PROPERTY. A client-side eject revokes no token, so a "Join now" here would
    // put an ejected participant straight back into a call the host believes is over.
    for (const reason of ['self', 'host_ended'] as const) {
      const { container, unmount } = render(
        <MeetingEndedNotice reason={reason} contextNoun="case" />
      );

      expect(container.querySelectorAll('button')).toHaveLength(0);
      expect(container.textContent ?? '').not.toMatch(/join|rejoin/i);
      unmount();
    }
  });

  it('says the HOST ended it when that is what happened, and names the context', () => {
    render(<MeetingEndedNotice reason="host_ended" contextNoun="retainer" />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(CALL_ENDED_TITLE);
    expect(screen.getByText(/all stay with the retainer/i)).toBeInTheDocument();
  });

  it('says YOU left when you did — a different fact, a different sentence', () => {
    render(<MeetingEndedNotice reason="self" contextNoun="case" />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(CALL_LEFT_TITLE);
    expect(screen.getByText(CALL_LEFT_BODY)).toBeInTheDocument();
  });

  it('⚠ the error arm renders a real card rather than a blank one', () => {
    const { container } = render(<MeetingEndedNotice reason="error" contextNoun="call" />);

    expect((container.textContent ?? '').length).toBeGreaterThan(0);
  });

  it('⚠ owns exactly one <h1>, and the ref reaches it', () => {
    const ref = { current: null as HTMLHeadingElement | null };
    const { container } = render(
      <MeetingEndedNotice reason="host_ended" contextNoun="case" headingRef={ref} />
    );

    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(ref.current).toBe(screen.getByRole('heading', { level: 1 }));
    expect(ref.current).toHaveAttribute('tabindex', '-1');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<MeetingEndedNotice reason="host_ended" contextNoun="case" />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
