import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import type { RelationshipStatus } from '@/lib/project-request/conversation-view-types';
import { ProposalSlot } from './proposal-slot';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000002';

describe('ProposalSlot — gated pill → live "Build proposal" CTA (keyed on the VIEWER relationship)', () => {
  it('renders the muted, aria-disabled pill while the viewer relationship is eoi_submitted', () => {
    render(
      <ProposalSlot
        requestId={REQUEST_ID}
        viewerRelationshipStatus="eoi_submitted"
        viewerRelationshipId={RELATIONSHIP_ID}
      />
    );
    const pill = screen.getByText('Awaiting proposal request');
    expect(pill).toBeInTheDocument();
    expect(pill.closest('[aria-disabled="true"]')).not.toBeNull();
  });

  it('renders the gated pill while still invited (pre-EOI)', () => {
    render(
      <ProposalSlot
        requestId={REQUEST_ID}
        viewerRelationshipStatus="invited"
        viewerRelationshipId={RELATIONSHIP_ID}
      />
    );
    expect(screen.getByText('Awaiting proposal request')).toBeInTheDocument();
  });

  it('renders the live "Build proposal" CTA linking to the composer once proposal_requested', () => {
    render(
      <ProposalSlot
        requestId={REQUEST_ID}
        viewerRelationshipStatus="proposal_requested"
        viewerRelationshipId={RELATIONSHIP_ID}
      />
    );
    const cta = screen.getByRole('link', { name: 'Build proposal' });
    expect(cta).toHaveAttribute('href', `/projects/${REQUEST_ID}/proposal/${RELATIONSHIP_ID}`);
  });

  it('renders nothing once the VIEWER relationship reaches proposal_submitted+ (A6.3 owns View)', () => {
    const postProposal: RelationshipStatus[] = ['proposal_submitted', 'accepted', 'declined'];
    for (const status of postProposal) {
      const { container } = render(
        <ProposalSlot
          requestId={REQUEST_ID}
          viewerRelationshipStatus={status}
          viewerRelationshipId={RELATIONSHIP_ID}
        />
      );
      expect(container).toBeEmptyDOMElement();
    }
  });

  it('renders nothing for a null viewer relationship (client/admin lens)', () => {
    const { container } = render(
      <ProposalSlot
        requestId={REQUEST_ID}
        viewerRelationshipStatus={null}
        viewerRelationshipId={null}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('falls back to nothing at proposal_requested if the relationship id is missing', () => {
    // Defensive: without a relationship id there is no composer URL to link to.
    const { container } = render(
      <ProposalSlot
        requestId={REQUEST_ID}
        viewerRelationshipStatus="proposal_requested"
        viewerRelationshipId={null}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('BAL-272 divergence: the pill persists for expert B while expert A is the one requested', () => {
    // The request status has advanced to proposal_requested via ANOTHER expert,
    // but THIS viewer's relationship is still eoi_submitted — the pill must stay.
    render(
      <ProposalSlot
        requestId={REQUEST_ID}
        viewerRelationshipStatus="eoi_submitted"
        viewerRelationshipId={RELATIONSHIP_ID}
      />
    );
    expect(screen.getByText('Awaiting proposal request')).toBeInTheDocument();
  });
});
