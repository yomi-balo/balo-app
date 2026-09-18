import { describe, expect, it, vi } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import CasesLoading from './loading';
import CasesError from './error';

/**
 * BAL-567 — the `/cases` segment's TWO boundaries. Both are rendered for real; none of these
 * assertions passes on a component that failed to mount.
 */

describe('CasesLoading', () => {
  it('announces itself as a labelled loading region', () => {
    render(<CasesLoading />);
    // `<output>` maps to role `status`; the label is what assistive tech reads out, instead of
    // a page of unlabelled empty boxes.
    expect(screen.getByRole('status', { name: /Loading cases/ })).toBeInTheDocument();
  });

  it('mirrors the real layout, so the route does not re-flow when the data lands', () => {
    const { container } = render(<CasesLoading />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(5);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<CasesLoading />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('CasesError', () => {
  it('states the cause and offers a way forward', () => {
    render(<CasesError error={new Error('boom')} reset={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      /couldn.t load your cases/i
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  /**
   * ⚠ AN `<h2>`, NOT AN `<h1>` — the boundary replaces the PAGE BODY, not the chrome, and
   * BAL-499's top bar is still rendering THE ONE `<h1>` above it (decisions D3).
   */
  it('never introduces a second h1', () => {
    render(<CasesError error={new Error('boom')} reset={vi.fn()} />);
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('invokes the reset prop when Try again is pressed', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<CasesError error={new Error('boom')} reset={reset} />);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<CasesError error={new Error('boom')} reset={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
