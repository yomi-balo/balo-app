import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import type { CaseEarningsView } from '@/lib/cases/case-view-types';
import { CaseEarningsBlock } from './case-earnings-block';

/**
 * BAL-421 (D2) — the expert lens's own-earnings block.
 *
 * ⚠⚠ THE `not_yet` TESTS ARE THE REASON THIS FILE EXISTS, AND THEY ASSERT AN ABSENCE OVER THE
 * WHOLE RENDERED TREE rather than over one element. Nothing writes `credit_sessions.
 * engagement_id` yet (BAL-400 will), so EVERY case on `main` today resolves to `not_yet` — a
 * component that formatted a number regardless would render "A$0.00" to EVERY EXPERT ON THE
 * PLATFORM. That is a MONEY CLAIM about work that has not been billed, not a cosmetic bug, and
 * a per-element assertion would miss it if the figure moved to a different node.
 *
 * ⚠ A `finalized` block CAN legitimately be `0` — a REAL zero — which is exactly why the three
 * states must stay visibly distinct and why "renders no figure" cannot be tested as "renders
 * no zero".
 */

const NOT_YET: CaseEarningsView = {
  state: 'not_yet',
  earningsAudMinor: null,
  finalizedCount: 0,
  pendingCount: 0,
};

/** Everything the component put on the page, as one string. */
function renderedText(container: HTMLElement): string {
  return container.textContent ?? '';
}

describe('CaseEarningsBlock — `not_yet` renders NO figure at all', () => {
  it('renders NO "A$" anywhere in the tree', () => {
    const { container } = render(<CaseEarningsBlock earnings={NOT_YET} />);
    expect(renderedText(container)).not.toContain('A$');
  });

  it('renders no zero figure either — not "0.00", not "0"', () => {
    const { container } = render(<CaseEarningsBlock earnings={NOT_YET} />);
    const text = renderedText(container);
    expect(text).not.toContain('0.00');
    // No digit at all belongs on this state.
    expect(text).not.toMatch(/\d/);
  });

  it('explains the absence instead, without promising an amount', () => {
    render(<CaseEarningsBlock earnings={NOT_YET} />);
    expect(
      screen.getByText('Earnings appear here once a consultation on this case has been billed.')
    ).toBeInTheDocument();
  });

  it('still labels the block, so the section is not a mystery', () => {
    render(<CaseEarningsBlock earnings={NOT_YET} />);
    expect(screen.getByText('Earned on this case')).toBeInTheDocument();
  });
});

describe('CaseEarningsBlock — `pending` states the count, never a figure', () => {
  it('renders NO "A$" while consultations are still finalising', () => {
    const { container } = render(
      <CaseEarningsBlock
        earnings={{ state: 'pending', earningsAudMinor: null, finalizedCount: 0, pendingCount: 2 }}
      />
    );
    expect(renderedText(container)).not.toContain('A$');
    expect(screen.getByText('2 consultations still being finalised.')).toBeInTheDocument();
  });

  it('singularises one pending consultation', () => {
    render(
      <CaseEarningsBlock
        earnings={{ state: 'pending', earningsAudMinor: null, finalizedCount: 0, pendingCount: 1 }}
      />
    );
    expect(screen.getByText('1 consultation still being finalised.')).toBeInTheDocument();
  });
});

describe('CaseEarningsBlock — `finalized` is the ONLY state that shows money', () => {
  it('renders the formatted figure', () => {
    const { container } = render(
      <CaseEarningsBlock
        earnings={{
          state: 'finalized',
          earningsAudMinor: 45_000,
          finalizedCount: 3,
          pendingCount: 0,
        }}
      />
    );
    expect(renderedText(container)).toContain('A$');
    expect(screen.getByText('from 3 consultations')).toBeInTheDocument();
  });

  /**
   * ⚠ A REAL ZERO. This is precisely why `not_yet` and `finalized: 0` must not share a shape —
   * "we billed nothing" and "nothing has been billed yet" are different facts, and only this
   * one may render a number.
   */
  it('renders a REAL zero as a figure — distinct from `not_yet`, which renders none', () => {
    const { container } = render(
      <CaseEarningsBlock
        earnings={{ state: 'finalized', earningsAudMinor: 0, finalizedCount: 1, pendingCount: 0 }}
      />
    );
    expect(renderedText(container)).toContain('A$');

    const { container: notYet } = render(<CaseEarningsBlock earnings={NOT_YET} />);
    expect(renderedText(notYet)).not.toContain('A$');
  });

  it('mentions any still-finalising remainder alongside the figure', () => {
    render(
      <CaseEarningsBlock
        earnings={{
          state: 'finalized',
          earningsAudMinor: 12_300,
          finalizedCount: 1,
          pendingCount: 2,
        }}
      />
    );
    expect(screen.getByText('from 1 consultation · 2 still finalising')).toBeInTheDocument();
  });
});

/**
 * ⚠⚠ FEE CONCEALMENT. This block renders own EARNINGS only — the un-marked-up accrual. The
 * Balo margin appears in NEITHER lens, and there is no client-side equivalent anywhere on this
 * surface (owner decision, 2026-07-31).
 */
describe('CaseEarningsBlock — no fee, margin or rate vocabulary reaches the DOM', () => {
  it.each([
    ['not_yet', NOT_YET],
    [
      'pending',
      { state: 'pending', earningsAudMinor: null, finalizedCount: 0, pendingCount: 2 } as const,
    ],
    [
      'finalized',
      {
        state: 'finalized',
        earningsAudMinor: 45_000,
        finalizedCount: 3,
        pendingCount: 1,
      } as const,
    ],
  ])('says nothing about margin/fee/markup on the %s state', (_label, earnings) => {
    const { container } = render(<CaseEarningsBlock earnings={earnings} />);
    const text = renderedText(container).toLowerCase();
    for (const word of ['margin', 'fee', 'markup', 'commission', 'balo takes', 'charged']) {
      expect(text).not.toContain(word);
    }
  });
});
