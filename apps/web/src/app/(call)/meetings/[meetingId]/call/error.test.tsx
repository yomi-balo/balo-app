import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import CallError from './error';

/**
 * BAL-435 — the call route's error boundary, mirroring BAL-132's `/join/m/[meetingId]`.
 *
 * ⚠ NOTHING IS LOGGED HERE, matching all 18 sibling boundaries: Sentry's client instrumentation
 * already captures React error boundaries, and CLAUDE.md bans `console.*` outside `middleware.ts`.
 */
const ERROR = Object.assign(new Error('postgres connection refused at 10.0.0.4'), {
  digest: 'abc123digest',
});

describe('CallError', () => {
  it('renders a neutral message and a retry control', () => {
    render(<CallError error={ERROR} reset={vi.fn()} />);

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('⚠⚠ NEVER renders the error message or its digest', () => {
    const { container } = render(<CallError error={ERROR} reset={vi.fn()} />);
    const markup = container.innerHTML;

    expect(markup).not.toContain('postgres');
    expect(markup).not.toContain('10.0.0.4');
    expect(markup).not.toContain('abc123digest');
  });

  it('reassures that nothing is lost — the meeting outlives the render', () => {
    const { container } = render(<CallError error={ERROR} reset={vi.fn()} />);

    expect(container.textContent ?? '').toMatch(/nothing is lost/i);
  });

  it('calls reset when retried', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<CallError error={ERROR} reset={reset} />);

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('⚠ offers a way out with the same label the back-link table uses', () => {
    render(<CallError error={ERROR} reset={vi.fn()} />);

    // The recap boundary already renders this exact string, so the two screens read as one
    // product by construction rather than by coincidence.
    expect(screen.getByRole('link', { name: 'Back to your dashboard' })).toHaveAttribute(
      'href',
      '/dashboard'
    );
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<CallError error={ERROR} reset={vi.fn()} />);

    expect(await axe(container)).toHaveNoViolations();
  });
});
