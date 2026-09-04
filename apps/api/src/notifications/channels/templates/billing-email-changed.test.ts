import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import {
  BillingEmailChangedEmail,
  BillingEmailChangedPreviousEmail,
  buildBillingEmailChangedCopy,
} from './billing-email-changed.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

const BASE = 'https://app.balo.expert';

/**
 * Normalise React-Email output: strip the `<!-- -->` markers it inserts around
 * interpolated text, and un-escape `&amp;`/`&#x27;` so copy assertions read naturally.
 */
function clean(html: string): string {
  return html
    .replaceAll('<!-- -->', '')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'");
}

// ── buildBillingEmailChangedCopy ──────────────────────────────────────────────
describe('buildBillingEmailChangedCopy (BAL-522)', () => {
  it('derives companyName/bareName/label/newEmail/previousEmail with warm fallbacks', () => {
    const copy = buildBillingEmailChangedCopy({
      company: { name: 'Northwind Industrial' },
      changedByName: 'Dana',
      changedByLabel: 'Dana @ Northwind Industrial',
      newEmail: 'dana@northwind.test',
      previousEmail: 'old@northwind.test',
    });
    expect(copy).toEqual({
      companyName: 'Northwind Industrial',
      bareName: 'Dana',
      label: 'Dana @ Northwind Industrial',
      newEmail: 'dana@northwind.test',
      previousEmail: 'old@northwind.test',
    });
  });

  it('falls back to "your team" / "A teammate" / null previousEmail when data is sparse', () => {
    const copy = buildBillingEmailChangedCopy({});
    expect(copy.companyName).toBe('your team');
    expect(copy.bareName).toBe('A teammate');
    expect(copy.label).toBe('A teammate');
    expect(copy.newEmail).toBe('');
    expect(copy.previousEmail).toBeNull();
  });
});

// ── BillingEmailChangedEmail (component) ──────────────────────────────────────
describe('BillingEmailChangedEmail (BAL-522)', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    firstName: 'Priya',
    label: 'Dana @ Northwind Industrial',
    companyName: 'Northwind Industrial',
    newEmail: 'dana@northwind.test',
    previousEmail: null as string | null,
    ctaUrl: `${BASE}/settings/billing`,
    baseUrl: BASE,
    ...over,
  });

  it('renders the lead sentence and, when there is a previous address, the "it replaces" clause', async () => {
    const html = clean(
      await render(BillingEmailChangedEmail(props({ previousEmail: 'old@northwind.test' })))
    );
    expect(html).toContain('Hi Priya,');
    expect(html).toContain(
      "Dana @ Northwind Industrial set Northwind Industrial's billing email to dana@northwind.test."
    );
    expect(html).toContain('It replaces old@northwind.test.');
    expect(html).toContain('Manage billing settings');
    expect(html).toContain(`${BASE}/settings/billing`);
  });

  it('omits the "it replaces" clause on a first-ever set (previousEmail null)', async () => {
    const html = clean(await render(BillingEmailChangedEmail(props())));
    expect(html).not.toContain('It replaces');
  });

  it('states Balo still sends receipts itself', async () => {
    const html = clean(await render(BillingEmailChangedEmail(props())));
    expect(html).toContain('Balo still sends your receipts itself');
  });

  it('uses no gendered pronouns anywhere', async () => {
    const html = await render(BillingEmailChangedEmail(props()));
    expect(html).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });
});

// ── BillingEmailChangedPreviousEmail (component) ──────────────────────────────
describe('BillingEmailChangedPreviousEmail (BAL-522)', () => {
  const props = (over: Record<string, unknown> = {}) => ({
    label: 'Dana @ Northwind Industrial',
    companyName: 'Northwind Industrial',
    baseUrl: BASE,
    ...over,
  });

  it('states the recipient is no longer the billing contact', async () => {
    const html = clean(await render(BillingEmailChangedPreviousEmail(props())));
    expect(html).toContain(
      "Dana @ Northwind Industrial updated Northwind Industrial's billing email on Balo. This address is no longer Northwind Industrial's billing contact."
    );
  });

  it('never prints a new-address value and never renders a CTA link', async () => {
    const html = clean(await render(BillingEmailChangedPreviousEmail(props())));
    expect(html).not.toContain('dana@northwind.test');
    expect(html).not.toContain('/settings/billing');
    expect(html).not.toContain('Manage billing settings');
  });

  it('uses no gendered pronouns anywhere', async () => {
    const html = await render(BillingEmailChangedPreviousEmail(props()));
    expect(html).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });
});

// ── getEmailTemplate factory ──────────────────────────────────────────────────
describe('getEmailTemplate — billing-email-changed / billing-email-changed-previous (BAL-522)', () => {
  it('billing-email-changed: subject uses the LABELLED "@ company" form (CLAUDE.md first-mention rule)', async () => {
    const out = getEmailTemplate('billing-email-changed', {
      recipientName: 'Sam',
      company: { name: 'Northwind Industrial' },
      changedByName: 'Dana',
      changedByLabel: 'Dana @ Northwind Industrial',
      newEmail: 'dana@northwind.test',
      previousEmail: 'old@northwind.test',
    });
    expect(out.subject).toBe("Dana @ Northwind Industrial updated your team's billing email");
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Sam,');
    expect(html).toContain('It replaces old@northwind.test.');
  });

  it('billing-email-changed falls back to "A teammate" when no actor name resolved', async () => {
    const out = getEmailTemplate('billing-email-changed', {
      company: { name: 'Northwind Industrial' },
      newEmail: 'dana@northwind.test',
    });
    expect(out.subject).toBe("A teammate updated your team's billing email");
  });

  it('billing-email-changed greets "there" for a name-less recipient', async () => {
    const out = getEmailTemplate('billing-email-changed', {
      company: { name: 'Northwind Industrial' },
      newEmail: 'dana@northwind.test',
    });
    const html = clean(await render(out.component));
    expect(html).toContain('Hi there,');
  });

  it('billing-email-changed-previous: subject names the company; the CTA is absent', async () => {
    const out = getEmailTemplate('billing-email-changed-previous', {
      company: { name: 'Northwind Industrial' },
      changedByLabel: 'Dana @ Northwind Industrial',
    });
    expect(out.subject).toBe("Your address is no longer Northwind Industrial's billing contact");
    const html = await render(out.component);
    expect(html).not.toContain('/settings/billing');
  });

  it('billing-email-changed-previous NEVER prints the new address', async () => {
    const out = getEmailTemplate('billing-email-changed-previous', {
      company: { name: 'Northwind Industrial' },
      newEmail: 'dana@northwind.test',
      changedByLabel: 'Dana @ Northwind Industrial',
    });
    const html = await render(out.component);
    expect(html).not.toContain('dana@northwind.test');
  });
});

// ── getInAppTemplate factory ───────────────────────────────────────────────────
describe('getInAppTemplate — billing-email-changed (BAL-522)', () => {
  it('titles "Billing email updated" and names the actor + company + new address', () => {
    const out = getInAppTemplate('billing-email-changed', {
      company: { name: 'Northwind Industrial' },
      changedByLabel: 'Dana @ Northwind Industrial',
      newEmail: 'dana@northwind.test',
      previousEmail: 'old@northwind.test',
    });
    expect(out.title).toBe('Billing email updated');
    expect(out.body).toBe(
      "Dana @ Northwind Industrial set Northwind Industrial's billing email to dana@northwind.test. It replaces old@northwind.test."
    );
    expect(out.actionUrl).toBe('/settings/billing');
  });

  it('omits the "it replaces" clause on a first-ever set', () => {
    const out = getInAppTemplate('billing-email-changed', {
      company: { name: 'Northwind Industrial' },
      changedByLabel: 'Dana @ Northwind Industrial',
      newEmail: 'dana@northwind.test',
    });
    expect(out.body).toBe(
      "Dana @ Northwind Industrial set Northwind Industrial's billing email to dana@northwind.test."
    );
  });
});
