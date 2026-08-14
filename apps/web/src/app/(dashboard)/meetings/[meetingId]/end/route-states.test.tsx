import { describe, it, expect, vi } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';

import EndOfCallLoading from './loading';
import EndOfCallError from './error';
import EndOfCallNotFound from './not-found';

describe('EndOfCallLoading', () => {
  it('announces itself as a labelled loading region', () => {
    // ⚠ `<output>`, not `role="status"` (SonarCloud S6819) — `<output>` maps to role status.
    expect(render(<EndOfCallLoading />).container.querySelector('output')).not.toBeNull();
    expect(screen.getByRole('status', { name: /Loading/ })).toBeInTheDocument();
  });

  it('stops every pulse under prefers-reduced-motion', () => {
    // ⚠ A skeleton is the longest-running animation on the route, and `prefers-reduced-motion`
    // is not a stylistic preference for the people who set it. The layout is unchanged either
    // way — the bars just hold still.
    const { container } = render(<EndOfCallLoading />);
    const pulsing = container.querySelectorAll('.animate-pulse');
    expect(pulsing.length).toBeGreaterThan(0);
    for (const node of pulsing) {
      expect(node.className).toContain('motion-reduce:animate-none');
    }
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<EndOfCallLoading />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * BAL-389 UX FIX — ALL FOUR ROUTE STATES SHARE ONE BOX.
 *
 * ⚠⚠ THE DEFECT: `loading.tsx` and `EndOfCallLayout` centred their card inside `min-h-[70vh]`
 * while `error.tsx` and `not-found.tsx` rendered a top-aligned block. A failed load therefore
 * did not read as "this card failed" — it read as the whole page jumping, because the content
 * snapped from the vertical centre to the top of the viewport. `EndOfCallShell` is the only
 * thing that keeps the four in lockstep.
 *
 * ⚠⚠ AND THE WASH IS FLAT, NOT A GRADIENT. The gradient was a child of the dashboard's
 * `max-w-7xl` inside `main.p-6`, so it was inset on all four sides and terminated in a visible
 * seam — a tinted rectangle floating on the page rather than atmosphere. The design reference
 * paints a FLAT background behind the card and lets the card carry the depth.
 */
describe('the end-of-call route states all render into ONE shell', () => {
  const STATES: ReadonlyArray<readonly [string, React.JSX.Element]> = [
    ['loading', <EndOfCallLoading key="l" />],
    ['error', <EndOfCallError key="e" error={new Error('boom')} reset={vi.fn()} />],
    ['not-found', <EndOfCallNotFound key="n" />],
  ];

  it.each(STATES)('centres %s in the same box, at the same width', (_label, element) => {
    const { container } = render(element);
    const shell = container.querySelector('.min-h-\\[70vh\\]');
    expect(shell).not.toBeNull();
    expect(shell?.className).toContain('items-center');
    expect(shell?.className).toContain('justify-center');
    expect(container.querySelector('.max-w-\\[440px\\]')).not.toBeNull();
  });

  it.each(STATES)('paints a FLAT background behind %s — never a gradient', (_label, element) => {
    const { container } = render(element);
    expect(container.innerHTML).not.toContain('bg-gradient');
    expect(container.querySelector('.bg-muted\\/30')).not.toBeNull();
  });
});

describe('EndOfCallError', () => {
  it('states the cause and offers a way forward', () => {
    render(<EndOfCallError error={new Error('boom')} reset={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t load this page/i);
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to your dashboard/ })).toBeInTheDocument();
  });

  it('overrides the settings-shaped default with the one reassurance this screen exists for', () => {
    render(<EndOfCallError error={new Error('boom')} reset={vi.fn()} />);
    expect(screen.getByText(/safely wrapped up/i)).toBeInTheDocument();
    expect(screen.queryByText(/your settings are safe/i)).not.toBeInTheDocument();
  });

  it('calls reset when Try again is pressed', async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<EndOfCallError error={new Error('boom')} reset={reset} />);
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it('LOGS NOTHING to the console, matching every sibling error boundary', () => {
    // CLAUDE.md bans `console.*` in application code outside `middleware.ts`, and Sentry client
    // instrumentation already captures React error boundaries.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<EndOfCallError error={new Error('boom')} reset={vi.fn()} />);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<EndOfCallError error={new Error('boom')} reset={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('EndOfCallNotFound', () => {
  it('uses ONE copy that does not distinguish missing from forbidden', () => {
    render(<EndOfCallNotFound />);
    expect(screen.getByRole('heading', { name: /Meeting not found/ })).toBeInTheDocument();
    const body = screen.getByText(/doesn.t exist, or you don.t have access to it/);
    expect(body).toBeInTheDocument();
    // ⚠ No 403, no "you are not a participant" — either would confirm the meeting EXISTS.
    expect(body.textContent).not.toMatch(/permission|participant|forbidden/i);
  });

  it('does NOT inherit the recap copy — this segment owns its own denial page', () => {
    // ⚠ WITHOUT THIS FILE, `notFound()` bubbles to the recap's `not-found.tsx` ("Recap not
    // found"), which is wrong copy for someone who just left a call.
    const { container } = render(<EndOfCallNotFound />);
    expect(container.textContent).not.toContain('Recap not found');
  });

  it('offers a way out', () => {
    render(<EndOfCallNotFound />);
    expect(screen.getByRole('link', { name: /Back to your dashboard/ })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<EndOfCallNotFound />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
