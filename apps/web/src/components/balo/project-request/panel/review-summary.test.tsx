import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { ProjectDraft } from './use-project-draft';

// Avoid mounting TipTap (the read-only viewer is code-split ProseMirror).
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextViewer: ({ value }: { value: string }) => <div data-testid="rt-viewer">{value}</div>,
}));

import { ReviewSummary } from './review-summary';

const DRAFT: ProjectDraft = {
  routing: 'direct',
  title: 'Lead routing rebuild',
  descriptionHtml: '<p>Rebuild lead routing in Flow.</p>',
  tagIds: ['t1'],
  productIds: ['p1'],
  documents: [
    {
      r2Key: 'project-documents/c/u/k',
      fileName: 'spec.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
    },
  ],
  budgetMinCents: 4500000,
  budgetMaxCents: 7000000,
  timeline: 'Target go-live: end of Q3',
};

const BASE = {
  expertName: 'Priya Sharma',
  expertInitials: 'PS',
  expertAvatarKey: null,
  tagNameMap: { t1: 'Data Migration' },
  productNameMap: { p1: 'Sales Cloud' },
};

describe('ReviewSummary', () => {
  it('renders the Direct routing block + every summary field', () => {
    render(<ReviewSummary draft={DRAFT} onEdit={vi.fn()} {...BASE} />);
    expect(screen.getByText('Going to Priya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Lead routing rebuild')).toBeInTheDocument();
    expect(screen.getByTestId('rt-viewer')).toHaveTextContent('Rebuild lead routing in Flow.');
    expect(screen.getByText('Data Migration')).toBeInTheDocument();
    expect(screen.getByText('Sales Cloud')).toBeInTheDocument();
    expect(screen.getByText('spec.pdf')).toBeInTheDocument();
  });

  it('renders the Match routing block', () => {
    render(<ReviewSummary draft={{ ...DRAFT, routing: 'match' }} onEdit={vi.fn()} {...BASE} />);
    expect(screen.getByText(/we'll match you with an expert/i)).toBeInTheDocument();
  });

  it('renders a neutral Direct routing block when no expert is supplied (context-free)', () => {
    render(
      <ReviewSummary
        draft={DRAFT}
        onEdit={vi.fn()}
        tagNameMap={BASE.tagNameMap}
        productNameMap={BASE.productNameMap}
      />
    );
    // Neutral copy — no expert name available.
    expect(screen.getByText('Going to an expert')).toBeInTheDocument();
    expect(screen.queryByText('Going to Priya Sharma')).not.toBeInTheDocument();
  });

  it('shows "None" for empty optional fields', () => {
    render(
      <ReviewSummary
        draft={{ ...DRAFT, tagIds: [], productIds: [], documents: [] }}
        onEdit={vi.fn()}
        {...BASE}
      />
    );
    expect(screen.getAllByText('None').length).toBeGreaterThanOrEqual(3);
  });

  it('renders the formatted budget range and timeline', () => {
    render(<ReviewSummary draft={DRAFT} onEdit={vi.fn()} {...BASE} />);
    expect(screen.getByText('A$45,000 – A$70,000')).toBeInTheDocument();
    expect(screen.getByText('Target go-live: end of Q3')).toBeInTheDocument();
  });

  it('shows "Not specified" when budget + timeline are null', () => {
    render(
      <ReviewSummary
        draft={{ ...DRAFT, budgetMinCents: null, budgetMaxCents: null, timeline: null }}
        onEdit={vi.fn()}
        {...BASE}
      />
    );
    expect(screen.getAllByText('Not specified').length).toBe(2);
  });

  it('fires onEdit from the Edit links', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<ReviewSummary draft={DRAFT} onEdit={onEdit} {...BASE} />);
    const editButtons = screen.getAllByRole('button', { name: /edit/i });
    await user.click(editButtons[0]!);
    expect(onEdit).toHaveBeenCalled();
  });
});
