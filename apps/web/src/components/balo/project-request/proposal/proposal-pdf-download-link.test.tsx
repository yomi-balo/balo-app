import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { ProposalPdfDownloadLink } from './proposal-pdf-download-link';

describe('ProposalPdfDownloadLink', () => {
  it('links to the authorized PDF route for the given request + relationship', () => {
    render(<ProposalPdfDownloadLink requestId="req-1" relationshipId="rel-9" />);
    const link = screen.getByRole('link', { name: /Download PDF/ });
    expect(link).toHaveAttribute('href', '/projects/req-1/proposal/rel-9/pdf');
  });

  it('is a native browser download (has the download attribute)', () => {
    render(<ProposalPdfDownloadLink requestId="req-1" relationshipId="rel-9" />);
    expect(screen.getByRole('link', { name: /Download PDF/ })).toHaveAttribute('download');
  });

  it('meets the 44px minimum tap target (min-h-11)', () => {
    render(<ProposalPdfDownloadLink requestId="req-1" relationshipId="rel-9" />);
    expect(screen.getByRole('link', { name: /Download PDF/ })).toHaveClass('min-h-11');
  });
});
