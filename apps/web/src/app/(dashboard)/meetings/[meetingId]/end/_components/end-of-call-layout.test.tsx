import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axe } from 'jest-axe';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { track, END_OF_CALL_EVENTS } from '@/lib/analytics';
import type {
  ClientEndOfCallView,
  ExpertEndOfCallView,
} from '@/lib/meetings/end-of-call-view-types';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000005';
const CASE_HREF = '/cases/' + ENGAGEMENT_ID;

vi.mock('server-only', () => ({}));
// Motion misbehaves under JSDOM; the entrance cascade is not what any assertion here is about.
// The SHARED stub keeps `className` (several tests read it) and memoises per tag so the subtree
// is not remounted on every render — see `@/test/motion-stub`.
vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/submit-engagement-review', () => ({
  submitEngagementReviewAction: vi.fn(),
}));
vi.mock('../../_actions/resolve-case', () => ({ resolveCaseAction: vi.fn() }));

import { ClientEndOfCall } from './client-end-of-call';
import { ExpertEndOfCall } from './expert-end-of-call';

const CLIENT_VIEW: ClientEndOfCallView = {
  meetingId: MEETING_ID,
  contextType: 'case',
  isCase: true,
  counterpartyName: 'Amara',
  durationMinutes: 45,
  recapState: 'processing',
  meetingHeld: true,
  caseHref: CASE_HREF,
  lens: 'client',
  rating: null,
  resolve: null,
};

const EXPERT_VIEW: ExpertEndOfCallView = {
  meetingId: MEETING_ID,
  contextType: 'case',
  isCase: true,
  counterpartyName: 'Northwind Industrial',
  durationMinutes: 45,
  recapState: 'processing',
  meetingHeld: true,
  caseHref: CASE_HREF,
  lens: 'expert',
};

describe('EndOfCallLayout — the duration glance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('states the elapsed time when both stamps are present', () => {
    render(<ClientEndOfCall view={CLIENT_VIEW} />);
    expect(screen.getByText(/You spoke for 45 min with Amara/)).toBeInTheDocument();
  });

  it('is ENTIRELY ABSENT when the duration is null — no fallback, no placeholder', () => {
    // ⚠ 100% of sessions today: BAL-134 owns the lifecycle stamps and is Backlog.
    render(<ClientEndOfCall view={{ ...CLIENT_VIEW, durationMinutes: null }} />);
    expect(screen.queryByText(/You spoke for/)).not.toBeInTheDocument();
    expect(screen.queryByText(/min with/)).not.toBeInTheDocument();
  });

  it('is ABSENT for a sub-minute call — never a bare zero', () => {
    render(<ClientEndOfCall view={{ ...CLIENT_VIEW, durationMinutes: 0 }} />);
    expect(screen.queryByText(/You spoke for/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 min/)).not.toBeInTheDocument();
  });
});

describe('EndOfCallLayout — NOTHING MONEY-SHAPED (ADR-1044)', () => {
  /**
   * ⚠ THE RECEIPT LIVES ON THE RECAP. This screen is throwaway and carries no charge, no rate,
   * no credit balance and no payout — and the loader never reads a money row, so this is true by
   * construction. The scan covers TEXT and MARKUP, on both lenses and both recap states.
   */
  const MONEY_SHAPES = ['$', 'A$', 'AUD', '/min', 'credit', 'charge', 'invoice'];

  const CASES: ReadonlyArray<readonly [string, React.JSX.Element]> = [
    ['client / processing', <ClientEndOfCall key="a" view={CLIENT_VIEW} />],
    ['client / ready', <ClientEndOfCall key="b" view={{ ...CLIENT_VIEW, recapState: 'ready' }} />],
    ['expert / processing', <ExpertEndOfCall key="c" view={EXPERT_VIEW} />],
    ['expert / ready', <ExpertEndOfCall key="d" view={{ ...EXPERT_VIEW, recapState: 'ready' }} />],
  ];

  it.each(CASES)('renders no money shape — %s', (_label, element) => {
    const { container } = render(element);
    const haystack = ((container.textContent ?? '') + container.innerHTML).toLowerCase();
    for (const shape of MONEY_SHAPES) {
      expect(haystack.includes(shape.toLowerCase()), 'must not contain ' + shape).toBe(false);
    }
  });

  it("promises the expert's payout SUMMARY without ever stating a figure", () => {
    // ⚠ `payout` is deliberately NOT in the shape list above: the expert reassurance copy is
    // verbatim design ("Your notes and payout summary are on the way"). The invariant is that no
    // AMOUNT appears — the summary itself lives on the recap and in email. The only digits this
    // screen may render are the duration minutes.
    const { container } = render(<ExpertEndOfCall key="p" view={EXPERT_VIEW} />);
    const text = container.textContent ?? '';
    expect(text).toContain('payout summary');
    const digits = [...text].filter((character) => character >= '0' && character <= '9').join('');
    expect(digits).toBe('45');
  });
});

describe('EndOfCallLayout — the per-lens copy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names the consultation on a client-lens CASE', () => {
    render(<ClientEndOfCall view={CLIENT_VIEW} />);
    expect(screen.getByRole('heading', { name: 'Consultation complete' })).toBeInTheDocument();
    expect(screen.getByText(/recap and receipt are on the way/)).toBeInTheDocument();
  });

  it('drops the receipt clause on a NON-case context', () => {
    render(
      <ClientEndOfCall view={{ ...CLIENT_VIEW, contextType: 'project_kickoff', isCase: false }} />
    );
    expect(screen.getByRole('heading', { name: 'Meeting complete' })).toBeInTheDocument();
    expect(screen.queryByText(/receipt/)).not.toBeInTheDocument();
  });

  it('greets the EXPERT differently and promises their own artefacts', () => {
    render(<ExpertEndOfCall view={EXPERT_VIEW} />);
    expect(screen.getByRole('heading', { name: 'Nice session' })).toBeInTheDocument();
    expect(screen.getByText(/notes and payout summary are on the way/)).toBeInTheDocument();
    // ⚠ THE CLIENT PARTY IS THE COMPANY, not a person (CLAUDE.md attribution).
    expect(screen.getByText(/with Northwind Industrial/)).toBeInTheDocument();
  });
});

/**
 * BAL-389 UX FIX — THE NEUTRAL VARIANT.
 *
 * ⚠⚠ NULLING THE TWO CONSEQUENTIAL CONTROLS WAS ONLY HALF THE FIX. For a FUTURE or CANCELLED
 * meeting reached by hand-typed URL the loader already withheld the rating and the close — but
 * the card still rendered a green success tick, asserted "Consultation complete", and promised a
 * recap and a RECEIPT that will never arrive. Three statements, all false, on both lenses.
 *
 * ⚠ THE ROUTE STILL RENDERS (owner decision). No `notFound()`, no redirect, and the onward CTA
 * stays: the recap route renders its own state for a meeting with nothing in it, and removing
 * the only way off the page is the worse wrong.
 */
describe('EndOfCallLayout — the neutral variant when the session has not been held', () => {
  beforeEach(() => vi.clearAllMocks());

  const NOT_HELD_CLIENT = { ...CLIENT_VIEW, meetingHeld: false } as const;
  const NOT_HELD_EXPERT = { ...EXPERT_VIEW, meetingHeld: false } as const;

  it('drops the completion claim on the CLIENT lens', () => {
    render(<ClientEndOfCall view={NOT_HELD_CLIENT} />);
    expect(screen.getByRole('heading', { name: 'Nothing to wrap up yet' })).toBeInTheDocument();
    expect(screen.queryByText(/complete/i)).not.toBeInTheDocument();
  });

  it('promises NO recap and NO receipt on the CLIENT lens', () => {
    const { container } = render(<ClientEndOfCall view={NOT_HELD_CLIENT} />);
    expect(container.textContent).not.toContain('receipt');
    expect(container.textContent).not.toMatch(/on the way/i);
    // ⚠ The processing subcopy is the SAME promise in smaller type — it goes too.
    expect(screen.queryByText('Your recap is being prepared.')).not.toBeInTheDocument();
  });

  it('drops "Nice session" and the PAYOUT promise on the EXPERT lens', () => {
    const { container } = render(<ExpertEndOfCall view={NOT_HELD_EXPERT} />);
    expect(screen.getByRole('heading', { name: 'Nothing to wrap up yet' })).toBeInTheDocument();
    expect(container.textContent).not.toContain('Nice session');
    // Naming a payout for work nobody has done is the worst of the four false statements.
    expect(container.textContent).not.toContain('payout');
  });

  it('renders a NEUTRAL mark — never the success tick, and never a greyed-out success tick', () => {
    const held = render(<ClientEndOfCall view={CLIENT_VIEW} />);
    expect(held.container.querySelector('.bg-success\\/10')).not.toBeNull();
    held.unmount();

    const { container } = render(<ClientEndOfCall view={NOT_HELD_CLIENT} />);
    expect(container.querySelector('.bg-success\\/10')).toBeNull();
    expect(container.querySelector('.text-success')).toBeNull();
  });

  it('KEEPS the onward CTA on both lenses — the route is never a dead end', () => {
    // ⚠ THE ASSERTION IS "THERE IS A WAY OFF THE PAGE", NOT WHICH LABEL IT CARRIES. These
    // fixtures are a CASE whose recap is still processing, so the CTA is the case arm — which is
    // the honest destination for a meeting that has not happened: there is no recap coming, so
    // "View recap" would be the odder of the two. The label itself is pinned below, by state.
    const client = render(<ClientEndOfCall view={NOT_HELD_CLIENT} />);
    expect(screen.getByRole('link', { name: /Back to the case/ })).toHaveAttribute(
      'href',
      CASE_HREF
    );
    client.unmount();

    render(<ExpertEndOfCall view={NOT_HELD_EXPERT} />);
    expect(screen.getByRole('link', { name: /Back to the case/ })).toBeInTheDocument();
  });

  it.each([
    ['client', <ClientEndOfCall key="n1" view={NOT_HELD_CLIENT} />],
    ['expert', <ExpertEndOfCall key="n2" view={NOT_HELD_EXPERT} />],
  ] as const)('has no accessibility violations — %s', async (_label, element) => {
    const { container } = render(element);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('OnwardCta — the design’s TWO onward states', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads "View recap" and carries ?from=end_of_call once the recap is READY', () => {
    render(<ClientEndOfCall view={{ ...CLIENT_VIEW, recapState: 'ready' }} />);
    // ⚠ THE QUERY PARAM IS REQUIRED. `RecapEntrySource` declares `end_of_call` and
    // `resolveEntrySource` whitelists it — dropping it here would ship a declared-but-never-
    // emitted funnel dimension.
    expect(screen.getByRole('link', { name: /View recap/ })).toHaveAttribute(
      'href',
      '/meetings/' + MEETING_ID + '?from=end_of_call'
    );
    expect(screen.queryByRole('link', { name: /Back to the case/ })).not.toBeInTheDocument();
  });

  it('reads "Back to the case" and links to /cases/{id} while the recap PROCESSES', () => {
    render(<ClientEndOfCall view={CLIENT_VIEW} />);
    // ⚠ NO `?from` ON THIS ARM, DELIBERATELY. Nothing reads a `from` param on `/cases/{id}` —
    // `case_surface_viewed` carries no `source` dimension — and an unread query string that
    // LOOKS like instrumentation is worse than none.
    expect(screen.getByRole('link', { name: /Back to the case/ })).toHaveAttribute(
      'href',
      CASE_HREF
    );
    expect(screen.queryByRole('link', { name: /View recap/ })).not.toBeInTheDocument();
  });

  it('FALLS BACK to "View recap" when the context has no case destination', () => {
    // ⚠ THE ARM IS GATED ON A DESTINATION, NOT ON A CONTEXT TYPE. `resolveCaseHref` returns
    // null for every non-`case` context and there is no `/projects/{contextId}` page of this
    // shape, so the processing arm must degrade to the recap rather than render a dead link.
    const { container } = render(
      <ClientEndOfCall
        view={{ ...CLIENT_VIEW, contextType: 'project_kickoff', isCase: false, caseHref: null }}
      />
    );
    expect(screen.getByRole('link', { name: /View recap/ })).toHaveAttribute(
      'href',
      '/meetings/' + MEETING_ID + '?from=end_of_call'
    );
    expect(container.textContent).not.toContain('Back to the');
  });

  it('shows the processing subcopy only while the recap is not ready', () => {
    const { unmount } = render(<ClientEndOfCall view={CLIENT_VIEW} />);
    expect(screen.getByText('Your recap is being prepared.')).toBeInTheDocument();
    unmount();

    render(<ClientEndOfCall view={{ ...CLIENT_VIEW, recapState: 'ready' }} />);
    expect(screen.queryByText('Your recap is being prepared.')).not.toBeInTheDocument();
  });

  it('tracks view_recap with the CLICKING lens', async () => {
    const user = userEvent.setup();
    render(<ClientEndOfCall view={{ ...CLIENT_VIEW, recapState: 'ready' }} />);
    await user.click(screen.getByRole('link', { name: /View recap/ }));
    expect(track).toHaveBeenCalledWith(END_OF_CALL_EVENTS.ACTION, {
      action: 'view_recap',
      lens: 'client',
    });
  });

  it('tracks back_to_case on the processing arm — the action follows the ARM, not the label', async () => {
    const user = userEvent.setup();
    render(<ClientEndOfCall view={CLIENT_VIEW} />);
    await user.click(screen.getByRole('link', { name: /Back to the case/ }));
    expect(track).toHaveBeenCalledWith(END_OF_CALL_EVENTS.ACTION, {
      action: 'back_to_case',
      lens: 'client',
    });
  });

  it('tracks the EXPERT lens as expert — it is a dimension, not a constant', async () => {
    const user = userEvent.setup();
    render(<ExpertEndOfCall view={{ ...EXPERT_VIEW, recapState: 'ready' }} />);
    await user.click(screen.getByRole('link', { name: /View recap/ }));
    expect(track).toHaveBeenCalledWith(END_OF_CALL_EVENTS.ACTION, {
      action: 'view_recap',
      lens: 'expert',
    });
  });
});

describe('EndOfCallLayout — the post-call slot', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders no divider or slot when there is nothing to put in it', () => {
    // A request-grain context: nothing to rate, no case to close. Handing the layout an island
    // that renders nothing would leave a dead divider and a dead gap on a card this small.
    const { container } = render(
      <ClientEndOfCall
        view={{ ...CLIENT_VIEW, contextType: 'request_interaction', isCase: false }}
      />
    );
    expect(screen.queryByText(/How was your/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Is this issue resolved/)).not.toBeInTheDocument();
    expect(container.querySelectorAll('.border-t')).toHaveLength(0);
  });

  it('mounts the island once there IS something to show', () => {
    render(
      <ClientEndOfCall
        view={{
          ...CLIENT_VIEW,
          rating: { engagementId: 'e1', state: { kind: 'none' }, existingBody: null },
        }}
      />
    );
    expect(screen.getByText('How was your consultation with Amara?')).toBeInTheDocument();
  });
});

/**
 * BAL-389 UX FIX — THE SCREEN HAD NO MOTION AT ALL.
 *
 * ⚠⚠ Its sibling recap runs a full staggered cascade through the SAME shipped `Reveal`, while
 * this screen — first paint, a meaningful state change and a success confirmation, i.e. all
 * three of balo-ui's top-priority animation moments at once — snapped into place. Reusing
 * `Reveal` rather than hand-rolling a second cascade is what keeps the two meeting surfaces
 * feeling like one product; `Reveal` also owns the `prefers-reduced-motion` branch, so there is
 * no second reduced-motion code path here to get wrong.
 */
describe('EndOfCallLayout — the entrance cascade and the flat wash', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pops the success mark on mount, and holds it still under reduced motion', () => {
    const { container } = render(<ClientEndOfCall view={CLIENT_VIEW} />);
    const mark = container.querySelector('.bg-success\\/10');
    expect(mark?.className).toContain('animate-in');
    expect(mark?.className).toContain('zoom-in-75');
    expect(mark?.className).toContain('motion-reduce:animate-none');
  });

  it('paints a FLAT background, never the inset gradient rectangle', () => {
    // ⚠ The gradient was a child of the dashboard's `max-w-7xl` inside `main.p-6`, so it was
    // inset on all four sides and ended in a visible seam. The design reference is flat.
    const { container } = render(<ClientEndOfCall view={CLIENT_VIEW} />);
    expect(container.innerHTML).not.toContain('bg-gradient');
    expect(container.querySelector('.bg-muted\\/30')).not.toBeNull();
  });

  it('renders into the SAME shell as the three route-state files', () => {
    const { container } = render(<ExpertEndOfCall view={EXPERT_VIEW} />);
    expect(container.querySelector('.min-h-\\[70vh\\]')).not.toBeNull();
    expect(container.querySelector('.max-w-\\[440px\\]')).not.toBeNull();
  });
});

describe('EndOfCallLayout — accessibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has no violations on the client lens', async () => {
    const { container } = render(<ClientEndOfCall view={CLIENT_VIEW} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations on the expert lens', async () => {
    const { container } = render(<ExpertEndOfCall view={EXPERT_VIEW} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
