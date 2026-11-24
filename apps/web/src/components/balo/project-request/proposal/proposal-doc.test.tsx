import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@/test/utils';
import { axe } from '@/test/axe';
import { track, EXPERT_PROFILE_EVENTS } from '@/lib/analytics';
import { ProposalDoc } from './proposal-doc';
import {
  BALO_TERMS_ADDITIVE_SENTENCE,
  BALO_TERMS_PRECEDENCE_SENTENCE,
} from './proposal-standard-terms';
import type { ProposalReviewDoc } from './proposal-review-types';

const VIEWER = { surface: 'proposal', lens: 'client' } as const;

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
    acceptedTermsVersion: null,
    overviewHtml: '<p>We will deliver CPQ.</p>',
    assumptions: [],
    exclusions: [],
    additionalTerms: [],
    clientCompanyName: 'Northwind',
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
      profileHref: null,
      rating: 4.9,
      ratingCount: 12,
    },
    ...overrides,
  };
}

describe('ProposalDoc — Fixed pricing', () => {
  it('renders the fixed price, per-milestone values, and the installment bar', () => {
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc()} />);

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
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc()} />);
    expect(screen.getByText(/Signed-off design doc/)).toBeInTheDocument();
    // The second milestone has no acceptance criteria — only one "Done when" line.
    expect(screen.getAllByText(/Done when:/)).toHaveLength(1);
  });
});

describe('ProposalDoc — milestone amounts are optional', () => {
  function withValues(first: number | null, second: number | null): ProposalReviewDoc {
    const base = baseDoc();
    const [a, b] = base.milestones;
    if (a === undefined || b === undefined) throw new Error('fixture needs two milestones');
    return {
      ...base,
      milestones: [
        { ...a, valueCents: first },
        { ...b, valueCents: second },
      ],
    };
  }

  it('renders no amount for a null milestone value', () => {
    render(<ProposalDoc termsViewer={VIEWER} doc={withValues(null, null)} />);
    expect(screen.getByText('Discovery')).toBeInTheDocument();
    expect(screen.queryByText('A$3,000')).not.toBeInTheDocument();
    expect(screen.queryByText('A$7,000')).not.toBeInTheDocument();
    expect(screen.queryByText('A$0')).not.toBeInTheDocument();
  });

  it('renders no amount for a zero milestone value', () => {
    render(<ProposalDoc termsViewer={VIEWER} doc={withValues(0, 0)} />);
    expect(screen.queryByText('A$0')).not.toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('still renders a positive amount beside a hidden one', () => {
    render(<ProposalDoc termsViewer={VIEWER} doc={withValues(null, 700_000)} />);
    expect(screen.getByText('A$7,000')).toBeInTheDocument();
    expect(screen.queryByText('A$0')).not.toBeInTheDocument();
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
    render(<ProposalDoc termsViewer={VIEWER} doc={tmDoc()} />);

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
        termsViewer={VIEWER}
        doc={baseDoc({ pricingMethod: 'tm', depositCents: null, rateCents: null, cadence: null })}
      />
    );
    expect(screen.getByText(/is an estimate, not a cap/)).toBeInTheDocument();
    expect(screen.queryByText(/deposit on acceptance/)).not.toBeInTheDocument();
  });
});

describe('ProposalDoc — header + revision', () => {
  it('shows the revised pill only when version > 1', () => {
    const { rerender } = render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc({ version: 1 })} />);
    expect(screen.queryByText(/revised/)).not.toBeInTheDocument();

    rerender(<ProposalDoc termsViewer={VIEWER} doc={baseDoc({ version: 3 })} />);
    expect(screen.getByText(/v3 · revised/)).toBeInTheDocument();
  });

  it('renders expert identity (name, company, rating, headline)', () => {
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc()} />);
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
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc()} />);
    expect(screen.getByText('(12)')).toBeInTheDocument();
  });

  /**
   * ⚠ THE DENOMINATOR MUST REACH A SCREEN READER TOO, AND AS "ENGAGEMENTS". The visual row
   * is three separate nodes — star, `4.9`, `(12)` — which announced as "4.9 12": two orphan
   * numbers, no scale, no noun. The `sr-only` sentence is the accessible name; the visual
   * nodes are `aria-hidden` so it is not read twice.
   */
  it('gives the rating an accessible name that says engagements', () => {
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc()} />);
    expect(screen.getByText('Rated 4.9 out of 5 across 12 engagements')).toBeInTheDocument();
  });

  /** It also used to render a raw `5` where the canonical badge shows `5.0`. */
  it('formats the rating to one decimal place', () => {
    const base = baseDoc();
    render(
      <ProposalDoc
        termsViewer={VIEWER}
        doc={{ ...base, expert: { ...base.expert, rating: 5, ratingCount: 1 } }}
      />
    );
    expect(screen.getByText('5.0')).toBeInTheDocument();
    // …and the accessible name singularises with it.
    expect(screen.getByText('Rated 5.0 out of 5 across 1 engagement')).toBeInTheDocument();
  });

  /** ⚠ NULL ⇒ NOTHING. Never `0.0`, and never a lone "(0)". */
  it('renders neither the rating nor its count when the expert is unrated', () => {
    const base = baseDoc();
    const { container } = render(
      <ProposalDoc
        termsViewer={VIEWER}
        doc={{ ...base, expert: { ...base.expert, rating: null, ratingCount: 0 } }}
      />
    );
    expect(container.textContent ?? '').not.toContain('0.0');
    expect(screen.queryByText('(0)')).not.toBeInTheDocument();
  });
});

describe('ProposalDoc — expert profile link', () => {
  it('links the avatar and the name to the public profile when the doc carries a profileHref', () => {
    const base = baseDoc();
    const { container } = render(
      <ProposalDoc
        termsViewer={VIEWER}
        doc={{ ...base, expert: { ...base.expert, profileHref: '/experts/priya-sharma' } }}
      />
    );
    const links = screen.getAllByRole('link', { name: 'Priya Sharma' });
    expect(links).toHaveLength(1);
    const [link] = links;
    expect(link).toHaveAttribute('href', '/experts/priya-sharma');
    expect(link).not.toHaveTextContent('Cloudwerx');
    const avatarLink = container.querySelector('a[data-expert-profile-avatar]');
    expect(avatarLink).toHaveAttribute('href', '/experts/priya-sharma');
    expect(avatarLink).toHaveAttribute('tabindex', '-1');
    // Hovering the avatar underlines the name: the row is the named group.
    expect(avatarLink?.parentElement).toHaveClass('group/expert-profile');
    expect(avatarLink).toHaveTextContent('PS');
  });

  it('reports a profile click as the proposal header', async () => {
    const user = userEvent.setup();
    vi.mocked(track).mockClear();
    const base = baseDoc();
    render(
      <ProposalDoc
        termsViewer={VIEWER}
        doc={{ ...base, expert: { ...base.expert, profileHref: '/experts/priya-sharma' } }}
      />
    );
    await user.click(screen.getByRole('link', { name: 'Priya Sharma' }));
    expect(track).toHaveBeenCalledWith(EXPERT_PROFILE_EVENTS.PROFILE_LINK_CLICKED, {
      surface: 'proposal_header',
    });
  });

  it('has no axe violations with the avatar + name linked', async () => {
    const base = baseDoc();
    const { container } = render(
      <ProposalDoc
        termsViewer={VIEWER}
        doc={{ ...base, expert: { ...base.expert, profileHref: '/experts/priya-sharma' } }}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders the avatar and name plain when profileHref is null (expert, admin, preview, share page)', () => {
    const { container } = render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc()} />);
    expect(screen.getByText('Priya Sharma')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Priya Sharma/ })).not.toBeInTheDocument();
    expect(container.querySelector('a[href^="/experts/"]')).toBeNull();
  });
});

describe('ProposalDoc — assumptions and exclusions', () => {
  it('omits the section when both lists are empty', () => {
    const { container } = render(
      <ProposalDoc termsViewer={VIEWER} doc={baseDoc()} sectionIdPrefix="sec-" />
    );
    expect(screen.queryByText('Assumptions and exclusions')).not.toBeInTheDocument();
    expect(screen.queryByText('Not included')).not.toBeInTheDocument();
    expect(container.querySelector('#sec-scope')).toBeNull();
  });

  it('renders numbered assumptions with the expert first-name lead', () => {
    const { container } = render(
      <ProposalDoc
        termsViewer={VIEWER}
        doc={baseDoc({ assumptions: ['Sandbox access by kickoff', 'Price list is final'] })}
        sectionIdPrefix="sec-"
      />
    );
    expect(screen.getByText('Assumptions and exclusions')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Assumptions' })).toBeInTheDocument();
    expect(screen.getByText('Priya’s price and timeline rely on these.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Not included' })).not.toBeInTheDocument();
    const list = container.querySelector('#sec-scope ol');
    expect(list).toHaveClass('list-decimal');
    expect(
      within(list as HTMLElement)
        .getAllByRole('listitem')
        .map((li) => li.textContent)
    ).toEqual(['Sandbox access by kickoff', 'Price list is final']);
  });

  it('renders the exclusions list with "Not included" and its lead on its own', () => {
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc({ exclusions: ['Data migration'] })} />);
    expect(screen.getByRole('heading', { name: 'Not included' })).toBeInTheDocument();
    expect(screen.getByText('Outside this proposal.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Assumptions' })).not.toBeInTheDocument();
    expect(screen.getByText('Data migration')).toBeInTheDocument();
  });

  it('renders markup in a body literally, never as HTML or rich text', () => {
    const { container } = render(
      <ProposalDoc
        termsViewer={VIEWER}
        doc={baseDoc({
          assumptions: ['<b>x</b>'],
          additionalTerms: ['<i>y</i>'],
        })}
      />
    );
    expect(screen.getByText('<b>x</b>')).toBeInTheDocument();
    expect(screen.getByText('<i>y</i>')).toBeInTheDocument();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('i')).toBeNull();
  });

  it('keeps a repeated body as separate list items', () => {
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc({ exclusions: ['Same', 'Same'] })} />);
    expect(screen.getAllByText('Same')).toHaveLength(2);
  });

  it('orders the sections: milestones, scope, payment, terms, attachments', () => {
    const { container } = render(
      <ProposalDoc
        termsViewer={VIEWER}
        doc={baseDoc({
          assumptions: ['A'],
          attachments: [{ id: 'a-1', fileName: 'spec.pdf', sizeBytes: 1000 }],
        })}
        sectionIdPrefix="sec-"
      />
    );
    const ids = Array.from(container.querySelectorAll('section[id^="sec-"]')).map((el) => el.id);
    expect(ids).toEqual([
      'sec-overview',
      'sec-milestones',
      'sec-scope',
      'sec-payment',
      'sec-terms',
      'sec-attachments',
    ]);
  });
});

describe('ProposalDoc — terms', () => {
  it('shows the Balo block with the client company in the pricing rule', () => {
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc({ clientCompanyName: 'Globex' })} />);
    expect(screen.getByText('Balo Project T&Cs apply')).toBeInTheDocument();
    expect(screen.getByText('The same terms for every project on Balo.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This is a fixed-price project. Any increase in cost is only charged if Globex approves it.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(BALO_TERMS_PRECEDENCE_SENTENCE)).not.toBeInTheDocument();
  });

  it('omits the additional-terms heading when the expert added none', () => {
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc()} />);
    expect(screen.queryByText(/additional terms/)).not.toBeInTheDocument();
    expect(screen.queryByText(BALO_TERMS_ADDITIVE_SENTENCE)).not.toBeInTheDocument();
  });

  it('lists the additional terms under the expert’s name with the additive lead', () => {
    render(
      <ProposalDoc
        termsViewer={VIEWER}
        doc={baseDoc({ additionalTerms: ['One revision round', 'Net 14'] })}
      />
    );
    expect(
      screen.getByRole('heading', { name: 'Priya Sharma’s additional terms' })
    ).toBeInTheDocument();
    expect(screen.getByText(BALO_TERMS_ADDITIVE_SENTENCE)).toBeInTheDocument();
    expect(screen.getByText('One revision round')).toBeInTheDocument();
    expect(screen.getByText('Net 14')).toBeInTheDocument();
  });

  it('renders no supplement tile for an attachment, whatever the file is', () => {
    render(
      <ProposalDoc
        termsViewer={VIEWER}
        doc={baseDoc({ attachments: [{ id: 'a-1', fileName: 'msa.pdf', sizeBytes: 120_000 }] })}
      />
    );
    expect(screen.getByText('msa.pdf')).toBeInTheDocument();
    expect(screen.queryByText(/additional terms ·/)).not.toBeInTheDocument();
    expect(screen.getByText('Attachments')).toBeInTheDocument();
  });
});

describe('ProposalDoc — attachments', () => {
  const attachments = [
    { id: 'a-2', fileName: 'architecture.pdf', sizeBytes: 200_000 },
    { id: 'a-3', fileName: 'terms.pdf', sizeBytes: 1_000 },
  ];

  it('renders each attachment as a plain row when no download handler is given', () => {
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc({ attachments })} />);
    expect(screen.getByText('architecture.pdf')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
  });

  it('renders each attachment as a Download button that calls onDownload', async () => {
    const user = userEvent.setup();
    const onDownload = vi.fn();
    render(
      <ProposalDoc termsViewer={VIEWER} doc={baseDoc({ attachments })} onDownload={onDownload} />
    );

    await user.click(screen.getByRole('button', { name: 'Download architecture.pdf' }));
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onDownload).toHaveBeenCalledWith(attachments[0]);
    expect(screen.getByRole('button', { name: 'Download terms.pdf' })).toBeEnabled();
  });

  it('disables only the row that is downloading', () => {
    render(
      <ProposalDoc
        termsViewer={VIEWER}
        doc={baseDoc({ attachments })}
        onDownload={vi.fn()}
        downloadingId="a-2"
      />
    );
    expect(screen.getByRole('button', { name: 'Download architecture.pdf' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Download terms.pdf' })).toBeEnabled();
  });

  it('keeps the 44px target on both row kinds', () => {
    const { rerender } = render(
      <ProposalDoc termsViewer={VIEWER} doc={baseDoc({ attachments })} />
    );
    expect(screen.getByText('architecture.pdf').closest('div.min-h-11')).not.toBeNull();
    rerender(
      <ProposalDoc termsViewer={VIEWER} doc={baseDoc({ attachments })} onDownload={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: 'Download architecture.pdf' })).toHaveClass(
      'min-h-11'
    );
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
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc()} showSummaryCells />);

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
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc()} showSummaryCells />);

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
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc()} showSummaryCells />);

    expect(screen.getAllByText('Fixed price')).toHaveLength(2);
    expect(within(grid()).getAllByText('Fixed price')).toHaveLength(1);
  });

  it('falls back to an em dash in the timeline cell when no timeframe was given', () => {
    render(
      <ProposalDoc termsViewer={VIEWER} doc={baseDoc({ timeframeWeeks: null })} showSummaryCells />
    );
    expect(cellValue('Est. timeline')).toBe('—');
    // …and the dash belongs to THAT cell: pinning a neighbour too is what makes a
    // swapped pair of values fail here instead of passing silently.
    expect(cellValue('Deliverables')).toBe('2 items');
  });

  it('keeps the T&M total treatment and derives the T&M payment cell', () => {
    render(
      <ProposalDoc
        termsViewer={VIEWER}
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
    render(
      <ProposalDoc termsViewer={VIEWER} doc={baseDoc({ pricingMethod: 'tm' })} showSummaryCells />
    );

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
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc()} />);

    expect(screen.queryByTestId('proposal-summary-cells')).not.toBeInTheDocument();
    expect(screen.getByText('Est. timeframe')).toBeInTheDocument();
    expect(screen.queryByText('Total amount')).not.toBeInTheDocument();
  });
});

describe('ProposalDoc — section anchoring', () => {
  it('anchors sections with ids + scroll margin when sectionIdPrefix is given', () => {
    const { container } = render(
      <ProposalDoc termsViewer={VIEWER} doc={baseDoc()} sectionIdPrefix="sec-" />
    );
    const overview = container.querySelector('#sec-overview');
    expect(overview).not.toBeNull();
    expect(overview?.className).toContain('scroll-mt-20');
    expect(container.querySelector('#sec-milestones')).not.toBeNull();
    expect(container.querySelector('#sec-payment')).not.toBeNull();
    expect(container.querySelector('#sec-terms')).not.toBeNull();
  });

  it('renders the same content without ids when no prefix is given', () => {
    const { container } = render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc()} />);
    expect(container.querySelector('#sec-overview')).toBeNull();
    // Content still renders.
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText(/Milestones/)).toBeInTheDocument();
  });
});

describe('ProposalDoc — Project T&Cs link', () => {
  it('links the public terms page while the proposal is open', () => {
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc({ status: 'submitted' })} />);
    expect(screen.getByRole('link', { name: /Read the Project T&Cs/ })).toHaveAttribute(
      'href',
      '/legal/project-terms'
    );
    expect(screen.queryByRole('link', { name: /Agreement dated/ })).not.toBeInTheDocument();
  });

  it('links the PDF of the accepted version once the proposal is accepted', () => {
    render(
      <ProposalDoc
        termsViewer={VIEWER}
        doc={baseDoc({ status: 'accepted', acceptedTermsVersion: '2025-07-23' })}
      />
    );
    expect(
      screen.getByRole('link', { name: /Agreement dated 23 July 2025 \(PDF\)/ })
    ).toHaveAttribute('href', '/legal/balo-projects-msa-2025-07-23.pdf');
    expect(screen.queryByRole('link', { name: /Read the Project T&Cs/ })).not.toBeInTheDocument();
  });

  it('falls back to the page link when an accepted proposal has no recorded version', () => {
    render(<ProposalDoc termsViewer={VIEWER} doc={baseDoc({ status: 'accepted' })} />);
    expect(screen.getByRole('link', { name: /Read the Project T&Cs/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Agreement dated/ })).not.toBeInTheDocument();
  });
});
