import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import type { RelationshipStatus } from '@/lib/project-request/conversation-view-types';
import { ProposalSlot } from './proposal-slot';

describe('ProposalSlot — gated "Build proposal" header slot (keyed on the VIEWER relationship)', () => {
  it('renders the muted, aria-disabled pill while the viewer relationship is eoi_submitted', () => {
    render(<ProposalSlot viewerRelationshipStatus="eoi_submitted" />);
    const pill = screen.getByText('Awaiting proposal request');
    expect(pill).toBeInTheDocument();
    expect(pill.closest('[aria-disabled="true"]')).not.toBeNull();
  });

  it('renders the gated pill while still invited (pre-EOI)', () => {
    render(<ProposalSlot viewerRelationshipStatus="invited" />);
    expect(screen.getByText('Awaiting proposal request')).toBeInTheDocument();
  });

  it('renders nothing once the VIEWER relationship reaches proposal_requested (A6 owns the live CTA)', () => {
    const postProposal: RelationshipStatus[] = [
      'proposal_requested',
      'proposal_submitted',
      'accepted',
      'declined',
    ];
    for (const status of postProposal) {
      const { container } = render(<ProposalSlot viewerRelationshipStatus={status} />);
      expect(container).toBeEmptyDOMElement();
    }
  });

  it('renders nothing for a null viewer relationship (client/admin lens)', () => {
    const { container } = render(<ProposalSlot viewerRelationshipStatus={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('BAL-272 divergence: the pill persists for expert B while expert A is the one requested', () => {
    // The request status has advanced to proposal_requested via ANOTHER expert,
    // but THIS viewer's relationship is still eoi_submitted — the pill must stay.
    render(<ProposalSlot viewerRelationshipStatus="eoi_submitted" />);
    expect(screen.getByText('Awaiting proposal request')).toBeInTheDocument();
  });
});
