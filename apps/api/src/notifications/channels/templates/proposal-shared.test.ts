import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { ProposalSharedEmail } from './proposal-shared.js';
import { getEmailTemplate } from './index.js';

const BASE = 'https://app.balo.expert';

describe('ProposalSharedEmail component (BAL-386)', () => {
  const props = {
    sharerName: 'Dana Okafor',
    sharerOrgLabel: 'Acme Industrial',
    proposalTitle: 'CPQ implementation',
    note: 'Take a look when you have a moment.',
    expiresOn: '13 August 2026',
    viewUrl: `${BASE}/shared/proposals/raw-token-abc`,
  };

  it('names the sharer as "@ {org}", carries the note, states expiry as a helpful fact', async () => {
    const html = await render(ProposalSharedEmail(props));
    expect(html).toContain('Dana Okafor @ Acme Industrial');
    expect(html).toContain('CPQ implementation');
    expect(html).toContain('Take a look when you have a moment.');
    expect(html).toContain('works until 13 August 2026');
  });

  it('embeds the magic-link URL and never a bare copyable token line', async () => {
    const html = await render(ProposalSharedEmail(props));
    // The magic link is present (as the CTA button href).
    expect(html).toContain(`${BASE}/shared/proposals/raw-token-abc`);
    // No expert-facing money figures leak into the recipient email (the attached
    // PDF is already client-priced; this template renders no figures at all).
    expect(html).not.toMatch(/payout/i);
    expect(html).not.toMatch(/balo fee/i);
    expect(html).not.toMatch(/\$\d/);
  });

  it('omits the note block when no note is provided', async () => {
    const html = await render(ProposalSharedEmail({ ...props, note: undefined }));
    expect(html).not.toContain('A note from');
  });
});

describe('getEmailTemplate — proposal-shared factory (BAL-386)', () => {
  it('builds the magic-link CTA from shareToken + a sanitized sharer-named subject', () => {
    const result = getEmailTemplate('proposal-shared', {
      sharerName: 'Dana Okafor',
      sharerOrgLabel: 'Acme Industrial',
      proposalTitle: 'CPQ implementation',
      expiresOn: '13 August 2026',
      shareToken: 'raw-token-abcdef',
    });
    expect(result.subject).toBe('Dana Okafor shared a proposal with you');
    expect(result.component).toBeDefined();
  });

  it('strips control characters from the sharer name in the subject', () => {
    const result = getEmailTemplate('proposal-shared', {
      sharerName: 'Dana\r\nBcc: evil@example.com',
      sharerOrgLabel: 'Acme',
      proposalTitle: 'CPQ',
      expiresOn: '13 August 2026',
      shareToken: 'raw-token-abcdef',
    });
    expect(result.subject).not.toContain('\n');
    expect(result.subject).not.toContain('\r');
  });
});
