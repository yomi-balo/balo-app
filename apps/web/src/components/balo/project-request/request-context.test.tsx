import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import type { RequestDetailView } from '@/lib/project-request/request-detail-view';

vi.mock('server-only', () => ({}));

import { RequestContext } from './request-context';

function view(overrides: Partial<RequestDetailView> = {}): RequestDetailView {
  return {
    id: 'req-1',
    title: 'CPQ implementation',
    descriptionHtml: '<p>We need a CPQ rebuild.</p>',
    products: [{ name: 'Revenue Cloud (CPQ)' }],
    tags: [{ name: 'Implementation' }],
    documents: [
      { id: 'doc-1', fileName: 'brief.pdf', sizeBytes: 1024, contentType: 'application/pdf' },
    ],
    companyName: 'Northwind Industrial',
    contact: { name: 'Dana Whitfield' },
    postedRelative: '3 days ago',
    status: 'eoi_submitted',
    budget: 'A$45,000 – A$70,000',
    timeline: 'Target go-live: end of Q3',
    relationships: [],
    ...overrides,
  };
}

describe('RequestContext (full / hero)', () => {
  it('renders the title, company, and brief', () => {
    render(<RequestContext view={view()} variant="full" />);
    expect(screen.getByRole('heading', { name: /CPQ implementation/i })).toBeInTheDocument();
    expect(screen.getByText('Northwind Industrial')).toBeInTheDocument();
    expect(screen.getByText(/We need a CPQ rebuild/i)).toBeInTheDocument();
  });

  it('shows the budget + timeline stats when present', () => {
    render(<RequestContext view={view()} variant="full" />);
    expect(screen.getByText('A$45,000 – A$70,000')).toBeInTheDocument();
    expect(screen.getByText('Target go-live: end of Q3')).toBeInTheDocument();
  });

  it('omits the budget + timeline stats when null', () => {
    render(<RequestContext view={view({ budget: null, timeline: null })} variant="full" />);
    expect(screen.queryByText('A$45,000 – A$70,000')).not.toBeInTheDocument();
    expect(screen.queryByText('Target go-live: end of Q3')).not.toBeInTheDocument();
  });

  it('shows the contact when present and hides it when null', () => {
    const { rerender } = render(<RequestContext view={view()} variant="full" />);
    expect(screen.getByText('Dana Whitfield')).toBeInTheDocument();
    rerender(<RequestContext view={view({ contact: null })} variant="full" />);
    expect(screen.queryByText('Dana Whitfield')).not.toBeInTheDocument();
  });

  it('renders cleanly with degenerate (all-empty) content — title + Posted, no broken chip rows', () => {
    render(
      <RequestContext
        view={view({
          products: [],
          tags: [],
          budget: null,
          timeline: null,
          contact: null,
          documents: [],
        })}
        variant="full"
      />
    );
    // The invariants that always render: the title heading and the Posted line.
    expect(screen.getByRole('heading', { name: /CPQ implementation/i })).toBeInTheDocument();
    expect(screen.getByText(/Posted 3 days ago/i)).toBeInTheDocument();
    // No budget/timeline stats and no contact when everything is empty.
    expect(screen.queryByText('A$45,000 – A$70,000')).not.toBeInTheDocument();
    expect(screen.queryByText('Dana Whitfield')).not.toBeInTheDocument();
  });
});

describe('RequestContext (compact / 3-card)', () => {
  it('renders all three cards with budget, timeline, contact, and posted', () => {
    render(<RequestContext view={view()} variant="compact" />);
    expect(screen.getByText('The request')).toBeInTheDocument();
    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(screen.getByText('Request documents')).toBeInTheDocument();
    expect(screen.getByText('A$45,000 – A$70,000')).toBeInTheDocument();
    expect(screen.getByText('Target go-live: end of Q3')).toBeInTheDocument();
    expect(screen.getByText('Dana Whitfield')).toBeInTheDocument();
    expect(screen.getByText('Posted 3 days ago')).toBeInTheDocument();
  });

  it('omits the Contact row when gated (null)', () => {
    render(<RequestContext view={view({ contact: null })} variant="compact" />);
    expect(screen.queryByText('Dana Whitfield')).not.toBeInTheDocument();
    // Details card still renders (budget/timeline present).
    expect(screen.getByText('Details')).toBeInTheDocument();
  });

  it('still renders the Details card with only Contact + Posted when budget/timeline are null', () => {
    render(<RequestContext view={view({ budget: null, timeline: null })} variant="compact" />);
    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(screen.getByText('Dana Whitfield')).toBeInTheDocument();
    expect(screen.getByText('Posted 3 days ago')).toBeInTheDocument();
  });

  it('always renders the Details card with Posted for a client lens with no budget/timeline/contact', () => {
    render(
      <RequestContext
        view={view({ budget: null, timeline: null, contact: null })}
        variant="compact"
      />
    );
    // Invariant: the Details card is never empty — Posted always shows.
    expect(screen.getByText('Details')).toBeInTheDocument();
    expect(screen.getByText('Posted 3 days ago')).toBeInTheDocument();
    // Conditional rows are correctly absent.
    expect(screen.queryByText('Budget')).not.toBeInTheDocument();
    expect(screen.queryByText('Timeline')).not.toBeInTheDocument();
    expect(screen.queryByText('Contact')).not.toBeInTheDocument();
  });

  it('shows a neutral note when there are no documents', () => {
    render(<RequestContext view={view({ documents: [] })} variant="compact" />);
    expect(screen.getByText(/No documents attached/i)).toBeInTheDocument();
  });
});
