import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { JoinRetryNotice, JoinUnavailableNotice } from './join-notice-card';
import {
  JOIN_TEMPORARILY_UNAVAILABLE_BODY,
  JOIN_TEMPORARILY_UNAVAILABLE_TITLE,
  JOIN_UNAVAILABLE_BODY,
  JOIN_UNAVAILABLE_TITLE,
} from '@/lib/meetings/lobby';

describe('JoinUnavailableNotice — the ONE card for every collapsed failure', () => {
  it('renders the shared title and body', () => {
    render(<JoinUnavailableNotice />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(JOIN_UNAVAILABLE_TITLE);
    expect(screen.getByText(JOIN_UNAVAILABLE_BODY)).toBeInTheDocument();
  });

  it('⚠⚠ NAMES NOTHING — no reason, no meeting, no company, no date, no inviter', () => {
    // A cancelled meeting, an ended one, a full room, a full queue, a denied knock, a revoked
    // token and an id that never existed all render THIS. Any variation is an oracle over a
    // guessed uuid.
    const { container } = render(<JoinUnavailableNotice />);
    const text = container.textContent ?? '';

    for (const forbidden of [
      /denied/i,
      /rejected/i,
      /removed/i,
      /revoked/i,
      /cancelled/i,
      /expired/i,
      /\bfull\b/i,
      /\bended\b/i,
      /\bmeeting\b/i,
      /\bcall\b/i,
    ]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it('⚠ offers no sign-in and no "email me a new link" — the recovery is a human one', () => {
    // A guest has no account, so "sign in" is a dead end that reads as "you need an account to
    // attend". An unauthenticated email-send primitive is an email-bomb amplifier and an
    // existence oracle — its own ticket.
    const { container } = render(<JoinUnavailableNotice />);
    const text = container.textContent ?? '';

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(text).not.toMatch(/sign in|sign up|log in|email me/i);
    expect(text).toMatch(/shared it with you/i);
  });

  it('⚠⚠ announces itself, and carries NO aria-busy (which would suppress that)', () => {
    // It appears as the RESULT of an action the visitor took, so a screen-reader user who
    // pressed the button and hears nothing has been told the click did nothing.
    const { container } = render(<JoinUnavailableNotice />);

    const region = container.querySelector('output');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-busy')).toBeNull();
  });

  it('exposes its heading as a focus target for the state transition', () => {
    const ref = createRef<HTMLHeadingElement>();
    render(<JoinUnavailableNotice headingRef={ref} />);

    expect(ref.current).not.toBeNull();
    // ⚠ `tabIndex={-1}` is what makes a non-interactive element focusable programmatically
    // WITHOUT adding it to the tab order.
    expect(ref.current?.getAttribute('tabindex')).toBe('-1');
    ref.current?.focus();
    expect(document.activeElement).toBe(ref.current);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<JoinUnavailableNotice />);

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('JoinRetryNotice — the ONE un-collapsed failure', () => {
  it('renders distinct, recoverable copy', () => {
    render(<JoinRetryNotice />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      JOIN_TEMPORARILY_UNAVAILABLE_TITLE
    );
    expect(screen.getByText(JOIN_TEMPORARILY_UNAVAILABLE_BODY)).toBeInTheDocument();
  });

  it('⚠ blames us, not the visitor — this is only reachable for a demonstrably real guest', () => {
    // A 503 is reachable ONLY after a ≥256-bit token resolved AND the bearer was already
    // admitted, so "this link isn't active" would be an outright lie that costs them the call.
    const { container } = render(<JoinRetryNotice />);

    expect(container.textContent ?? '').toMatch(/on our side/i);
    expect(container.textContent ?? '').not.toContain(JOIN_UNAVAILABLE_TITLE);
  });

  it('⚠ still names no meeting and no vendor', () => {
    const { container } = render(<JoinRetryNotice />);
    const text = container.textContent ?? '';

    for (const forbidden of [/daily/i, /denied/i, /cancelled/i, /\bfull\b/i]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it('offers a retry when given one, and none when not', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();

    const { unmount } = render(<JoinRetryNotice onRetry={onRetry} />);
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();

    render(<JoinRetryNotice />);
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<JoinRetryNotice onRetry={vi.fn()} />);

    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('⚠ the two cards are DISTINGUISHABLE from each other, and only from each other', () => {
  it('renders different markup', () => {
    const collapsed = render(<JoinUnavailableNotice />).container.innerHTML;
    const retry = render(<JoinRetryNotice />).container.innerHTML;

    expect(collapsed).not.toBe(retry);
  });
});
