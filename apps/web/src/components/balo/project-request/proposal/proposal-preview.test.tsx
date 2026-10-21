import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { ProposalPreview } from './proposal-preview';
import { draftToReviewDoc } from './proposal-draft-preview';
import { emptyDraftState, nextDraftKey } from './proposal-composer-state';

// The real viewer is a ssr:false dynamic Tiptap render — swap for a div that echoes its HTML.
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextViewer: ({ value }: { value: string }) => <div data-testid="rt-viewer">{value}</div>,
  isDescriptionEmpty: (html: string) => html.replace(/<[^<>]*>/g, '').trim() === '',
}));

const DOC = draftToReviewDoc(
  {
    ...emptyDraftState(),
    overview: '<p>We will deliver CPQ.</p>',
    fixedPriceCents: 500_000,
    installments: [{ key: nextDraftKey(), label: 'Upfront', pct: 100 }],
    milestones: [
      {
        key: nextDraftKey(),
        title: 'Discovery',
        descriptionHtml: '',
        acceptanceCriteria: '',
        valueCents: null,
        estimatedMinutes: null,
      },
    ],
  },
  {
    requestId: '11111111-1111-1111-1111-111111111111',
    relationshipId: '22222222-2222-2222-2222-222222222222',
    version: 1,
    expert: {
      name: 'Dana Expert',
      initials: 'DE',
      company: null,
      headline: null,
      rating: null,
      ratingCount: 0,
    },
  }
);

function renderPreview(overrides: Partial<React.ComponentProps<typeof ProposalPreview>> = {}): {
  onBack: ReturnType<typeof vi.fn>;
  onSend: ReturnType<typeof vi.fn>;
} {
  const onBack = vi.fn();
  const onSend = vi.fn();
  render(
    <ProposalPreview
      doc={DOC}
      requestTitle="CPQ rollout"
      companyName="Northwind"
      reviseMode={false}
      pending={false}
      onBack={onBack}
      onSend={onSend}
      {...overrides}
    />
  );
  return { onBack, onSend };
}

describe('ProposalPreview', () => {
  it('frames the preview with the banner copy and the request title', () => {
    renderPreview();

    expect(screen.getByText('Previewing as Northwind')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Amounts are what you receive. Northwind sees them with Balo's service margin added."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'CPQ rollout' })).toBeInTheDocument();
  });

  it('capitalises the fallback company at the start of the sentence', () => {
    renderPreview({ companyName: 'the client' });

    expect(screen.getByText('Previewing as the client')).toBeInTheDocument();
    expect(
      screen.getByText(/The client sees them with Balo's service margin added\./)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to the client' })).toBeInTheDocument();
  });

  it('shows the expert price at identity and never the marked-up figure', () => {
    const { container } = render(
      <ProposalPreview
        doc={DOC}
        requestTitle="CPQ rollout"
        companyName="Northwind"
        reviseMode={false}
        pending={false}
        onBack={vi.fn()}
        onSend={vi.fn()}
      />
    );

    expect(container).toHaveTextContent('A$5,000');
    expect(container).not.toHaveTextContent('A$6,250');
  });

  it('fires Back and Send', async () => {
    const user = userEvent.setup();
    const { onBack, onSend } = renderPreview();

    await user.click(screen.getByRole('button', { name: 'Back to editing' }));
    await user.click(screen.getByRole('button', { name: 'Send to Northwind' }));

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('disables both actions while a send is pending', () => {
    renderPreview({ pending: true });

    expect(screen.getByRole('button', { name: 'Back to editing' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send to Northwind' })).toBeDisabled();
  });

  it('reads Resend in revise mode', () => {
    renderPreview({ reviseMode: true });

    expect(screen.getByRole('button', { name: 'Resend to Northwind' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send to Northwind' })).not.toBeInTheDocument();
  });

  it('moves focus to the banner heading on mount', () => {
    renderPreview();
    expect(screen.getByRole('heading', { name: 'Previewing as Northwind' })).toHaveFocus();
  });
});
