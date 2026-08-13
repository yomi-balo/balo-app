import { describe, it, expect, vi } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';

import CaseLoading from './loading';
import CaseError from './error';
import CaseNotFound from './not-found';

/**
 * BAL-421 — the case route's three SEGMENT BOUNDARIES. Each is rendered for real; none of these
 * assertions passes on a component that failed to mount.
 */

describe('CaseLoading', () => {
  it('announces itself as a labelled loading region', () => {
    render(<CaseLoading />);
    // `<output>` maps to role `status`; the label is what assistive tech reads out.
    expect(screen.getByRole('status', { name: /Loading case/ })).toBeInTheDocument();
  });

  it('renders the skeleton structure, so the route does not re-flow when data lands', () => {
    const { container } = render(<CaseLoading />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(5);
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<CaseLoading />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('CaseError', () => {
  it('states the cause and offers a way forward', () => {
    render(<CaseError error={new Error('boom')} reset={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load this case/i);
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to your dashboard/ })).toHaveAttribute(
      'href',
      '/dashboard'
    );
  });

  it('overrides the settings-shaped default reassurance line', () => {
    render(<CaseError error={new Error('boom')} reset={vi.fn()} />);
    expect(
      screen.getByText(/your consultations, files and messages are all still here/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/your settings are safe/i)).not.toBeInTheDocument();
  });

  it('invokes the reset prop when Try again is pressed', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<CaseError error={new Error('boom')} reset={reset} />);
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it('LOGS NOTHING to the console, matching every sibling error boundary', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<CaseError error={new Error('boom')} reset={vi.fn()} />);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<CaseError error={new Error('boom')} reset={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('CaseNotFound', () => {
  it('uses ONE copy that does not distinguish missing from forbidden', () => {
    render(<CaseNotFound />);
    expect(screen.getByRole('heading', { name: /Case not found/ })).toBeInTheDocument();
    const body = screen.getByText(/doesn.t exist, or you don.t have access to it/);
    expect(body).toBeInTheDocument();
    // ⚠ No 403, no "you are not a participant" — either would confirm the case EXISTS, turning
    // the route into an existence oracle over every `engagements.id` on the platform.
    expect(body.textContent).not.toMatch(/permission|participant|forbidden|member|tenant/i);
  });

  it('offers a way out', () => {
    render(<CaseNotFound />);
    expect(screen.getByRole('link', { name: /Back to your dashboard/ })).toHaveAttribute(
      'href',
      '/dashboard'
    );
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<CaseNotFound />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
