import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import type { ProjectRequestStatus } from '@/lib/project-request/resolve-request-lens';
import { ProposalSlot } from './proposal-slot';

describe('ProposalSlot — gated "Build proposal" header slot', () => {
  it('renders the muted, aria-disabled "Awaiting proposal request" pill before a proposal is requested', () => {
    render(<ProposalSlot requestStatus="eoi_submitted" />);
    const pill = screen.getByText('Awaiting proposal request');
    expect(pill).toBeInTheDocument();
    expect(pill.closest('[aria-disabled="true"]')).not.toBeNull();
  });

  it('renders the gated pill at experts_invited (Phase-1 pre-EOI)', () => {
    render(<ProposalSlot requestStatus="experts_invited" />);
    expect(screen.getByText('Awaiting proposal request')).toBeInTheDocument();
  });

  it('renders nothing once a proposal has been requested (A6 owns the live CTA)', () => {
    const postProposal: ProjectRequestStatus[] = [
      'proposal_requested',
      'proposal_submitted',
      'accepted',
      'kickoff_approved',
    ];
    for (const status of postProposal) {
      const { container } = render(<ProposalSlot requestStatus={status} />);
      expect(container).toBeEmptyDOMElement();
    }
  });
});
