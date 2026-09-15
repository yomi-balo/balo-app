import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@/test/utils';
import { ProposalDoc } from './proposal-doc';
import type { ProposalReviewDoc } from './proposal-review-types';

// The real viewer is a ssr:false dynamic Tiptap render — swap for a div that
// echoes its HTML. `isDescriptionEmpty` treats empty / whitespace HTML as empty
// so the milestone description block can hide.
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextViewer: ({ value }: { value: string }) => <div data-testid="rt-viewer">{value}</div>,
  isDescriptionEmpty: (html: string) => html.replace(/<[^<>]*>/g, '').trim() === '',
}));

function baseDoc(overrides: Partial<ProposalReviewDoc> = {}): ProposalReviewDoc {
  return {
    id: 'prop-1',
    relationshipId: 'rel-1',
    version: 1,
    status: 'submitted',
    pricingMethod: 'fixed',
    overviewHtml: '<p>We will deliver CPQ.</p>',
    exclusionsHtml: '<p>Data migration is out of scope.</p>',
    priceCents: 1_000_000,
    currency: 'aud',
    timeframeWeeks: 6,
    depositCents: null,
    rateCents: null,
    cadence: null,
    milestones: [
      {
        id: 'm-1',
        title: 'Discovery',
        descriptionHtml: '<p>Workshops and design.</p>',
        acceptanceCriteria: 'Signed-off design doc',
        valueCents: 300_000,
      },
      {
        id: 'm-2',
        title: 'Build',
        descriptionHtml: null,
        acceptanceCriteria: null,
        valueCents: 700_000,
      },
    ],
    installments: [
      { id: 'i-1', label: 'Upfront', pct: 30 },
      { id: 'i-2', label: 'Final', pct: 70 },
    ],
    attachments: [],
    expert: {
      name: 'Priya Sharma',
      initials: 'PS',
      company: 'Cloudwerx',
      headline: 'CPQ Specialist',
      rating: 4.9,
      ratingCount: 12,
    },
    ...overrides,
  };
}

describe('ProposalDoc — Fixed pricing', () => {
  it('renders the fixed price, per-milestone values, and the installment bar', () => {
    render(<ProposalDoc doc={baseDoc()} />);

    // 'Fixed price' appears twice: the method pill (header) + the banner label.
    expect(screen.getAllByText('Fixed price')).toHaveLength(2);
    expect(screen.getByText('A$10,000')).toBeInTheDocument();

    // Per-milestone values (Fixed only): 30% and 70% of A$10,000.
    expect(screen.getByText('A$3,000')).toBeInTheDocument();
    expect(screen.getByText('A$7,000')).toBeInTheDocument();

    // Installment percentages appear twice each (bar segment + per-row label).
    expect(screen.getAllByText('30%')).toHaveLength(2);
    expect(screen.getAllByText('70%')).toHaveLength(2);
    expect(screen.getByText(/Upfront — A\$3,000/)).toBeInTheDocument();
    expect(screen.getByText(/Final — A\$7,000/)).toBeInTheDocument();
  });

  it('shows the acceptance "Done when" line only when criteria is present', () => {
    render(<ProposalDoc doc={baseDoc()} />);
    expect(screen.getByText(/Signed-off design doc/)).toBeInTheDocument();
    // The second milestone has no acceptance criteria — only one "Done when" line.
    expect(screen.getAllByText(/Done when:/)).toHaveLength(1);
  });
});

describe('ProposalDoc — Time & materials', () => {
  function tmDoc(): ProposalReviewDoc {
    return baseDoc({
      pricingMethod: 'tm',
      priceCents: 800_000,
      depositCents: 600_000,
      rateCents: 25_000,
      cadence: 'monthly',
    });
  }

  it('renders deposit / rate / cadence and the estimate label, not per-milestone values', () => {
    render(<ProposalDoc doc={tmDoc()} />);

    // Estimated-total banner with the est. suffix.
    expect(screen.getByText('Estimated total')).toBeInTheDocument();
    expect(screen.getByText('est.')).toBeInTheDocument();

    // Real T&M fields.
    expect(screen.getByText(/A\$6,000 deposit on acceptance/)).toBeInTheDocument();
    expect(screen.getByText(/A\$250\/hr/)).toBeInTheDocument();
    expect(screen.getByText(/Invoiced monthly/)).toBeInTheDocument();
    expect(screen.getByText(/is an estimate, not a cap/)).toBeInTheDocument();

    // No per-milestone amounts in T&M.
    expect(screen.queryByText('A$3,000')).not.toBeInTheDocument();
    expect(screen.queryByText('A$7,000')).not.toBeInTheDocument();
  });

  it('guards null T&M fields without crashing', () => {
    render(
      <ProposalDoc
        doc={baseDoc({ pricingMethod: 'tm', depositCents: null, rateCents: null, cadence: null })}
      />
    );
    expect(screen.getByText(/is an estimate, not a cap/)).toBeInTheDocument();
    expect(screen.queryByText(/deposit on acceptance/)).not.toBeInTheDocument();
  });
});

describe('ProposalDoc — header + revision', () => {
  it('shows the revised pill only when version > 1', () => {
    const { rerender } = render(<ProposalDoc doc={baseDoc({ version: 1 })} />);
    expect(screen.queryByText(/revised/)).not.toBeInTheDocument();

    rerender(<ProposalDoc doc={baseDoc({ version: 3 })} />);
    expect(screen.getByText(/v3 · revised/)).toBeInTheDocument();
  });

  it('renders expert identity (name, company, rating, headline)', () => {
    render(<ProposalDoc doc={baseDoc()} />);
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText(/Cloudwerx/)).toBeInTheDocument();
    // ⚠ EXACT, NOT `/4\.9/`. The rating now also carries an `sr-only` sentence containing
    // the same digits (see `InlineRating`), so a regex matches BOTH nodes and throws
    // "found multiple elements". The exact string pins the VISUAL node, and the accessible
    // name has its own assertion below.
    expect(screen.getByText('4.9')).toBeInTheDocument();
    expect(screen.getByText(/CPQ Specialist/)).toBeInTheDocument();
  });

  /**
   * ⚠ BAL-422 AC — THE AVERAGE NEVER SHIPS WITHOUT ITS DENOMINATOR. This surface rendered a
   * bare average with NO count before; "4.9" alone reads as settled evidence when it may rest
   * on a single engagement.
   */
  it('renders the review count alongside the rating', () => {
    render(<ProposalDoc doc={baseDoc()} />);
    expect(screen.getByText('(12)')).toBeInTheDocument();
  });

  /**
   * ⚠ THE DENOMINATOR MUST REACH A SCREEN READER TOO, AND AS "ENGAGEMENTS". The visual row
   * is three separate nodes — star, `4.9`, `(12)` — which announced as "4.9 12": two orphan
   * numbers, no scale, no noun. The `sr-only` sentence is the accessible name; the visual
   * nodes are `aria-hidden` so it is not read twice.
   */
  it('gives the rating an accessible name that says engagements', () => {
    render(<ProposalDoc doc={baseDoc()} />);
    expect(screen.getByText('Rated 4.9 out of 5 across 12 engagements')).toBeInTheDocument();
  });

  /** It also used to render a raw `5` where the canonical badge shows `5.0`. */
  it('formats the rating to one decimal place', () => {
    const base = baseDoc();
    render(
      <ProposalDoc doc={{ ...base, expert: { ...base.expert, rating: 5, ratingCount: 1 } }} />
    );
    expect(screen.getByText('5.0')).toBeInTheDocument();
    // …and the accessible name singularises with it.
    expect(screen.getByText('Rated 5.0 out of 5 across 1 engagement')).toBeInTheDocument();
  });

  /** ⚠ NULL ⇒ NOTHING. Never `0.0`, and never a lone "(0)". */
  it('renders neither the rating nor its count when the expert is unrated', () => {
    const base = baseDoc();
    const { container } = render(
      <ProposalDoc doc={{ ...base, expert: { ...base.expert, rating: null, ratingCount: 0 } }} />
    );
    expect(container.textContent ?? '').not.toContain('0.0');
    expect(screen.queryByText('(0)')).not.toBeInTheDocument();
  });
});

describe('ProposalDoc — attachments split + exclusions', () => {
  it('folds a kind:"terms" attachment into Terms, not Attachments', () => {
    render(
      <ProposalDoc
        doc={baseDoc({
          attachments: [{ id: 'a-1', fileName: 'msa.pdf', sizeBytes: 120_000, kind: 'terms' }],
        })}
      />
    );
    // Supplement row appears under Terms.
    expect(screen.getByText('msa.pdf')).toBeInTheDocument();
    expect(screen.getByText(/additional terms/)).toBeInTheDocument();
    // No Attachments section heading when there are no non-terms files.
    expect(screen.queryByText('Attachments')).not.toBeInTheDocument();
  });

  it('lists a non-terms attachment under Attachments', () => {
    render(
      <ProposalDoc
        doc={baseDoc({
          attachments: [
            { id: 'a-2', fileName: 'architecture.pdf', sizeBytes: 200_000, kind: 'ref' },
          ],
        })}
      />
    );
    expect(screen.getByText('Attachments')).toBeInTheDocument();
    expect(screen.getByText('architecture.pdf')).toBeInTheDocument();
  });

  it('hides "Not included" when exclusions are absent', () => {
    const { rerender } = render(<ProposalDoc doc={baseDoc()} />);
    expect(screen.getByText('Not included')).toBeInTheDocument();

    rerender(<ProposalDoc doc={baseDoc({ exclusionsHtml: null })} />);
    expect(screen.queryByText('Not included')).not.toBeInTheDocument();
  });
});

describe('ProposalDoc — client summary cells (BAL-392)', () => {
  function grid(): HTMLElement {
    return screen.getByTestId('proposal-summary-cells');
  }

  /**
   * The value rendered inside ONE NAMED cell, reached through its own label.
   *
   * `within(grid()).getByText('—')` is NOT anchored to a cell: it matches the em dash
   * wherever in the grid it appears, so swapping two cells' values still passes. Pairing
   * the `<dt>` label with the `<dd>` in the same cell wrapper is what makes the
   * assertion fail when a value lands in the wrong cell.
   */
  function cellValue(label: string): string {
    const term = within(grid()).getByText(label);
    const cell = term.closest('div');
    if (cell === null) throw new Error(`No cell wrapper for the "${label}" label`);
    return within(cell).getByRole('definition').textContent ?? '';
  }

  it('renders the four cells, with the same labels and derivations as the PDF', () => {
    render(<ProposalDoc doc={baseDoc()} showSummaryCells />);

    const cells = grid();
    for (const label of ['Pricing', 'Est. timeline', 'Payment', 'Deliverables']) {
      expect(within(cells).getByText(label)).toBeInTheDocument();
    }
    // baseDoc: fixed, 6 weeks, installments[0] = 30% Upfront, 2 milestones. Each value is
    // read through ITS OWN label, so a value rendered in the wrong cell fails here rather
    // than passing on mere presence somewhere in the grid.
    expect(cellValue('Pricing')).toBe('Fixed price');
    expect(cellValue('Est. timeline')).toBe('~6 weeks');
    expect(cellValue('Payment')).toBe('30% upfront');
    expect(cellValue('Deliverables')).toBe('2 items');
  });

  /** The two-item banner is REPLACED, not supplemented — and its label retires with it. */
  it('swaps the total label to "Total amount" and drops the timeframe item', () => {
    render(<ProposalDoc doc={baseDoc()} showSummaryCells />);

    expect(screen.getByText('Total amount')).toBeInTheDocument();
    expect(screen.getByText('A$10,000')).toBeInTheDocument();
    expect(screen.queryByText('Est. timeframe')).not.toBeInTheDocument();
  });

  /**
   * Still TWO 'Fixed price' nodes with the prop on — the header pill plus the PRICING
   * cell — because the total row now reads 'Total amount'. Pin WHICH nodes, so the count
   * matching the default path is not a coincidence.
   */
  it('renders "Fixed price" in the header pill and the PRICING cell, nowhere else', () => {
    render(<ProposalDoc doc={baseDoc()} showSummaryCells />);

    expect(screen.getAllByText('Fixed price')).toHaveLength(2);
    expect(within(grid()).getAllByText('Fixed price')).toHaveLength(1);
  });

  it('falls back to an em dash in the timeline cell when no timeframe was given', () => {
    render(<ProposalDoc doc={baseDoc({ timeframeWeeks: null })} showSummaryCells />);
    expect(cellValue('Est. timeline')).toBe('—');
    // …and the dash belongs to THAT cell: pinning a neighbour too is what makes a
    // swapped pair of values fail here instead of passing silently.
    expect(cellValue('Deliverables')).toBe('2 items');
  });

  it('keeps the T&M total treatment and derives the T&M payment cell', () => {
    render(
      <ProposalDoc
        doc={baseDoc({
          pricingMethod: 'tm',
          depositCents: 600_000,
          rateCents: 25_000,
          cadence: 'monthly',
        })}
        showSummaryCells
      />
    );

    expect(screen.getByText('Estimated total')).toBeInTheDocument();
    expect(screen.getByText('est.')).toBeInTheDocument();
    // ⚠ SCOPED TO THE GRID because the header pill now renders the SAME string (BAL-392) —
    // an unscoped `getByText` would throw on two matches. The pill itself is pinned by the
    // next test; this one is about the cell.
    expect(within(grid()).getByText('Time & materials')).toBeInTheDocument();
    expect(within(grid()).getByText('Deposit + rate')).toBeInTheDocument();
  });

  /**
   * ⚠ THE PILL, NOT THE CELL. The header pill stacks directly above the PRICING cell on
   * this surface, so it reads `pricingMethodLabel` too — a client can no longer see
   * `Time & Materials` above `Time & materials`. Capital-M is RETIRED here.
   *
   * The count is what makes this fail if the pill is hardcoded back: a grid-scoped query
   * would pass either way.
   */
  it('spells the header pill with the canonical lower-case "Time & materials"', () => {
    render(<ProposalDoc doc={baseDoc({ pricingMethod: 'tm' })} showSummaryCells />);

    const matches = screen.getAllByText('Time & materials');
    expect(matches).toHaveLength(2); // the pill + the PRICING cell
    // …and exactly one of them is the pill, i.e. OUTSIDE the grid.
    expect(matches.filter((node) => !grid().contains(node))).toHaveLength(1);
    expect(screen.queryByText('Time & Materials')).not.toBeInTheDocument();
  });

  /**
   * ⚠ THE REGRESSION PIN THAT KEEPS THE EXPERT SURFACE SAFE WITH NO EDIT TO
   * `submitted-view.tsx`. Default OFF must stay today's two-item banner.
   */
  it('renders the shipped two-item banner and no grid by default', () => {
    render(<ProposalDoc doc={baseDoc()} />);

    expect(screen.queryByTestId('proposal-summary-cells')).not.toBeInTheDocument();
    expect(screen.getByText('Est. timeframe')).toBeInTheDocument();
    expect(screen.queryByText('Total amount')).not.toBeInTheDocument();
  });
});

describe('ProposalDoc — section anchoring', () => {
  it('anchors sections with ids + scroll margin when sectionIdPrefix is given', () => {
    const { container } = render(<ProposalDoc doc={baseDoc()} sectionIdPrefix="sec-" />);
    const overview = container.querySelector('#sec-overview');
    expect(overview).not.toBeNull();
    expect(overview?.className).toContain('scroll-mt-20');
    expect(container.querySelector('#sec-milestones')).not.toBeNull();
    expect(container.querySelector('#sec-payment')).not.toBeNull();
    expect(container.querySelector('#sec-terms')).not.toBeNull();
  });

  it('renders the same content without ids when no prefix is given', () => {
    const { container } = render(<ProposalDoc doc={baseDoc()} />);
    expect(container.querySelector('#sec-overview')).toBeNull();
    // Content still renders.
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText(/Milestones/)).toBeInTheDocument();
  });
});
