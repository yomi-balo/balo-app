import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { StatementDownloadLink } from './statement-download-link';

describe('StatementDownloadLink', () => {
  it('links to the receipt PDF route with a download attribute', () => {
    render(<StatementDownloadLink sessionId="session_1" lens="client" />);
    const link = screen.getByRole('link', { name: /Download this receipt as a PDF/ });
    expect(link).toHaveAttribute('href', '/sessions/session_1/receipt/pdf');
    expect(link).toHaveAttribute('download');
  });

  it('links to the payout PDF route', () => {
    render(<StatementDownloadLink sessionId="session_1" lens="expert" />);
    const link = screen.getByRole('link', { name: /Download this payout statement as a PDF/ });
    expect(link).toHaveAttribute('href', '/sessions/session_1/payout/pdf');
  });
});
