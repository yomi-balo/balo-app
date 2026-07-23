import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { RecapReadyEmail } from './recap-ready.js';
import { getEmailTemplate } from './index.js';

const BASE = 'https://app.balo.expert';

const props = (over: Record<string, unknown> = {}) => ({
  firstName: 'Dana',
  summaryHeadline: 'Agreed to migrate CPQ config before the next sync.',
  actionItemCount: 3,
  engagementId: 'eng-1',
  baseUrl: BASE,
  ...over,
});

/** Strip the React-Email `<!-- -->` interpolation markers so multi-part text reads naturally. */
function clean(html: string): string {
  return html.replaceAll('<!-- -->', '').replaceAll('&amp;', '&');
}

describe('RecapReadyEmail (BAL-387)', () => {
  it('greets by first name and deep-links the CTA to the delivery workspace', async () => {
    const html = clean(await render(RecapReadyEmail(props())));
    expect(html).toContain('Hi Dana,');
    expect(html).toContain('Your session recap is ready.');
    expect(html).toContain('/engagements/eng-1');
  });

  it('renders the summary callout when a headline is present', async () => {
    const html = clean(await render(RecapReadyEmail(props())));
    expect(html).toContain('Summary');
    expect(html).toContain('Agreed to migrate CPQ config before the next sync.');
  });

  it('omits the summary callout when no headline is set', async () => {
    const html = clean(await render(RecapReadyEmail(props({ summaryHeadline: undefined }))));
    expect(html).not.toContain('Summary');
  });

  it('pluralizes the action-item line for multiple items', async () => {
    const html = clean(await render(RecapReadyEmail(props({ actionItemCount: 3 }))));
    expect(html).toContain('3 action items are ready to review.');
  });

  it('uses the singular action-item line for exactly one item', async () => {
    const html = clean(await render(RecapReadyEmail(props({ actionItemCount: 1 }))));
    expect(html).toContain('1 action item is ready to review.');
    expect(html).not.toContain('1 action items');
  });

  it('omits the action-item line entirely when there are none', async () => {
    const html = clean(await render(RecapReadyEmail(props({ actionItemCount: 0 }))));
    expect(html).not.toContain('action item');
    expect(html).toContain('Your session summary is ready to read.');
  });

  it('falls back to the "there" greeting for a name-less recipient', async () => {
    const html = clean(await render(RecapReadyEmail(props({ firstName: 'there' }))));
    expect(html).toContain('Hi there,');
  });

  it('uses no countdown / pressure framing (the recap is a helpful fact)', async () => {
    const html = await render(RecapReadyEmail(props()));
    expect(html).not.toMatch(/deadline|overdue|countdown|last chance|hurry|act now/i);
  });

  it('uses no gendered pronouns', async () => {
    const html = await render(RecapReadyEmail(props()));
    expect(html).not.toMatch(/\b(he|him|his|she|her|hers)\b/i);
  });
});

describe('getEmailTemplate — recap-ready factory', () => {
  it('greets by recipientName, carries a stable subject, and deep-links the engagement', async () => {
    const out = getEmailTemplate('recap-ready', {
      recipientName: 'Dana',
      summaryHeadline: 'Migration plan agreed.',
      actionItemCount: 2,
      engagementId: 'eng-9',
    });
    expect(out.subject).toBe('Your session recap is ready');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Dana,');
    expect(html).toContain('Migration plan agreed.');
    expect(html).toContain('2 action items are ready to review.');
    expect(html).toContain('/engagements/eng-9');
  });

  it('degrades gracefully when optional fields are absent', async () => {
    const out = getEmailTemplate('recap-ready', {});
    const html = clean(await render(out.component));
    expect(html).toContain('Hi there,');
    expect(html).toContain('Your session summary is ready to read.');
    expect(html).not.toContain('action item');
  });
});
