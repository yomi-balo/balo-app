import { describe, expect, it } from 'vitest';
import { axe } from 'jest-axe';
import { CASE_JOIN_WINDOW_MINUTES } from '@balo/shared/engagements';
import { render, screen } from '@/test/utils';
import { JoinCountdown } from './join-countdown';

/**
 * The join slot's INACTIVE arm. A deliberate, narrow exception to "an absent action beats a
 * dead one": this may render inactive only because it becomes active on its own and says when.
 */
describe('JoinCountdown', () => {
  it('renders the given label as a real <button>', () => {
    render(<JoinCountdown label="Join in 2 days" />);
    const button = screen.getByRole('button', { name: /Join in 2 days/ });
    expect(button.tagName).toBe('BUTTON');
  });

  it('is aria-disabled, NEVER the native disabled attribute — it stays focusable', () => {
    render(<JoinCountdown label="Join tomorrow" />);
    const button = screen.getByRole('button', { name: /Join tomorrow/ });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute('disabled');
    button.focus();
    expect(button).toHaveFocus();
  });

  it('describes when it opens, via CASE_JOIN_WINDOW_MINUTES — never a literal 15', () => {
    render(<JoinCountdown label="Join in 40 minutes" />);
    const button = screen.getByRole('button', { name: /Join in 40 minutes/ });
    expect(button).toHaveAccessibleDescription(
      `Opens ${CASE_JOIN_WINDOW_MINUTES} minutes before the start.`
    );
  });

  it('carries no animation of its own — the pulse ring on Join is the nudge’s only motion', () => {
    render(<JoinCountdown label="Join in 3 hours" />);
    const button = screen.getByRole('button', { name: /Join in 3 hours/ });
    expect(button.className).not.toMatch(/animate-/);
  });

  it('never fades its text with a 40%-opacity trick — "in 2 days" is information, not a disabled hint', () => {
    render(<JoinCountdown label="Join in 2 days" />);
    const button = screen.getByRole('button', { name: /Join in 2 days/ });
    // The base button's `disabled:opacity-50` never applies — it is a CSS variant gated on the
    // native `disabled` attribute, which this control (deliberately) never sets.
    expect(button.className).not.toMatch(/(?<!disabled:)opacity-40/);
    expect(button).not.toBeDisabled();
  });

  it('does nothing on click — the server is the authority on the crossing, not a click here', () => {
    render(<JoinCountdown label="Join in 40 minutes" />);
    const button = screen.getByRole('button', { name: /Join in 40 minutes/ });
    button.click();
    expect(button).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<JoinCountdown label="Join in 2 days" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
