import { describe, it, expect } from 'vitest';
import { statementPdfFileName } from './statement-pdf-file-name';

describe('statementPdfFileName', () => {
  it('builds the receipt filename with the UTC date + 8-char session id', () => {
    expect(
      statementPdfFileName(
        'client',
        '2026-08-12T10:00:00.000Z',
        '8f2c1a3d-0000-4000-8000-000000000000'
      )
    ).toBe('Balo-Receipt-2026-08-12-8f2c1a3d.pdf');
  });

  it('builds the payout filename', () => {
    expect(
      statementPdfFileName(
        'expert',
        '2026-08-12T10:00:00.000Z',
        '8f2c1a3d-0000-4000-8000-000000000000'
      )
    ).toBe('Balo-Payout-2026-08-12-8f2c1a3d.pdf');
  });

  it('omits the date segment when occurredAtIso is null', () => {
    expect(statementPdfFileName('client', null, '8f2c1a3d-0000-4000-8000-000000000000')).toBe(
      'Balo-Receipt-8f2c1a3d.pdf'
    );
  });
});
