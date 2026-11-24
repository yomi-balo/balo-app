import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@/test/utils';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { TermsPdfLink } from './terms-pdf-link';

const HREF = '/legal/balo-projects-msa-2025-07-23.pdf';

describe('TermsPdfLink', () => {
  it('download mode saves the file under its versioned name', () => {
    render(
      <TermsPdfLink href={HREF} version="2025-07-23" surface="page" mode="download">
        Download PDF
      </TermsPdfLink>
    );
    const link = screen.getByRole('link', { name: 'Download PDF' });
    expect(link).toHaveAttribute('href', HREF);
    expect(link).toHaveAttribute('download', 'balo-projects-msa-2025-07-23.pdf');
    expect(link).not.toHaveAttribute('target');
  });

  it('new_tab mode opens a new tab and says so to screen readers', () => {
    render(
      <TermsPdfLink href={HREF} version="2025-07-23" surface="proposal" mode="new_tab">
        Agreement dated 23 July 2025 (PDF)
      </TermsPdfLink>
    );
    const link = screen.getByRole('link', {
      name: /^Agreement dated 23 July 2025 \(PDF\)\s?\(opens in a new tab\)$/,
    });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).not.toHaveAttribute('download');
  });

  it.each(['download', 'new_tab'] as const)('tracks the click in %s mode', (mode) => {
    vi.mocked(track).mockClear();
    render(
      <TermsPdfLink href={HREF} version="2025-07-23" surface="delivery" mode={mode}>
        PDF
      </TermsPdfLink>
    );
    fireEvent.click(screen.getByRole('link'));
    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_TERMS_PDF_DOWNLOADED, {
      version: '2025-07-23',
      surface: 'delivery',
    });
  });
});
