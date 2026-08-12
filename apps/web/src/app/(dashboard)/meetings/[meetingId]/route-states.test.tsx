import { describe, it, expect, vi } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';

import RecapLoading from './loading';
import RecapError from './error';
import RecapNotFound from './not-found';

describe('RecapLoading', () => {
  it('announces itself as a labelled loading region', () => {
    render(<RecapLoading />);
    expect(screen.getByRole('status', { name: /Loading recap/ })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<RecapLoading />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('RecapError', () => {
  it('states the cause and offers a way forward', () => {
    render(<RecapError error={new Error('boom')} reset={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load this recap/i);
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to your dashboard/ })).toBeInTheDocument();
  });

  it('overrides the settings-shaped default reassurance line', () => {
    render(<RecapError error={new Error('boom')} reset={vi.fn()} />);
    expect(screen.getByText(/your action items and files are all still here/i)).toBeInTheDocument();
    expect(screen.queryByText(/your settings are safe/i)).not.toBeInTheDocument();
  });

  it('calls reset when Try again is pressed', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<RecapError error={new Error('boom')} reset={reset} />);
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it('LOGS NOTHING to the console, matching every sibling error boundary', () => {
    // CLAUDE.md bans `console.*` in application code outside `middleware.ts`, and Sentry client
    // instrumentation already captures React error boundaries - so a `console.error` here was
    // an unstructured record nothing collects, in the only one of 19 boundaries that did it.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<RecapError error={new Error('boom')} reset={vi.fn()} />);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<RecapError error={new Error('boom')} reset={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('RecapNotFound', () => {
  it('uses ONE copy that does not distinguish missing from forbidden', () => {
    render(<RecapNotFound />);
    expect(screen.getByRole('heading', { name: /Recap not found/ })).toBeInTheDocument();
    const body = screen.getByText(/doesn.t exist, or you don.t have access to it/);
    expect(body).toBeInTheDocument();
    // ⚠ No 403, no "you are not a participant" — either would confirm the meeting EXISTS.
    expect(body.textContent).not.toMatch(/permission|participant|forbidden/i);
  });

  it('offers a way out', () => {
    render(<RecapNotFound />);
    expect(screen.getByRole('link', { name: /Back to your dashboard/ })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<RecapNotFound />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
