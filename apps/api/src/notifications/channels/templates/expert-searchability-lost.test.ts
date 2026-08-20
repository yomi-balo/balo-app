import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { ExpertSearchabilityLostEmail } from './expert-searchability-lost.js';
import { getEmailTemplate } from './index.js';

const BASE = 'https://app.balo.expert';

const props = (over: Record<string, unknown> = {}) => ({
  firstName: 'Dana',
  failingItemLabels: ['connect a calendar', 'set up payouts'],
  ctaUrl: `${BASE}/expert/settings`,
  baseUrl: BASE,
  ...over,
});

function clean(html: string): string {
  return html.replaceAll('<!-- -->', '').replaceAll('&amp;', '&');
}

describe('ExpertSearchabilityLostEmail (BAL-414)', () => {
  it('greets by first name and links the CTA to expert settings', async () => {
    const html = clean(await render(ExpertSearchabilityLostEmail(props())));
    expect(html).toContain('Hi Dana,');
    expect(html).toContain(`${BASE}/expert/settings`);
    expect(html).toContain('Finish your setup');
  });

  it('falls back to the "there" greeting for a name-less recipient', async () => {
    const html = clean(await render(ExpertSearchabilityLostEmail(props({ firstName: 'there' }))));
    expect(html).toContain('Hi there,');
  });

  it('states both the search de-list and the public-profile pause', async () => {
    const html = await render(ExpertSearchabilityLostEmail(props()));
    expect(html).toMatch(/stopped appearing in Balo search/i);
    expect(html).toMatch(/public profile link is on hold/i);
  });

  it('lists the failing items by their human labels', async () => {
    const html = await render(
      ExpertSearchabilityLostEmail(props({ failingItemLabels: ['set your rate'] }))
    );
    expect(html).toContain('set your rate');
  });

  it('joins two failing items with "and", and three+ with a comma list', async () => {
    const two = await render(
      ExpertSearchabilityLostEmail(
        props({ failingItemLabels: ['set your rate', 'set up payouts'] })
      )
    );
    expect(two).toContain('set your rate and set up payouts');

    const three = await render(
      ExpertSearchabilityLostEmail(
        props({
          failingItemLabels: ['complete your profile', 'set your rate', 'set up payouts'],
        })
      )
    );
    expect(three).toContain('complete your profile, set your rate and set up payouts');
  });

  it('uses no deadline / countdown / threat framing (a quiet fact, not a threat)', async () => {
    const html = await render(ExpertSearchabilityLostEmail(props()));
    expect(html).not.toMatch(/deadline|expires?|countdown|last chance|hurry|act now|urgent/i);
  });

  it('reassures that the account and past bookings are untouched', async () => {
    const html = await render(ExpertSearchabilityLostEmail(props()));
    expect(html).toMatch(/untouched/i);
  });

  // BLOCKER 4 (fix round 1) — `rate` regressing is one of the things that TRIGGERS this email
  // (see the factory test below with `failingItems: ['rate']`), so the reassurance line must
  // never claim the rate itself is untouched — that would contradict the "What's left" line two
  // sentences later on the exact audience this email is sent to.
  it('does NOT claim the rate is untouched, even when rate is the failing item', async () => {
    const html = await render(
      ExpertSearchabilityLostEmail(props({ failingItemLabels: ['set your rate'] }))
    );
    expect(html).not.toMatch(/rate.{0,20}untouched/is);
    expect(html).not.toMatch(/untouched.{0,20}rate/is);
  });

  it('is gender-neutral — no gendered pronoun anywhere in the copy', async () => {
    const html = await render(ExpertSearchabilityLostEmail(props()));
    expect(html).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
  });
});

describe('getEmailTemplate — expert-searchability-lost factory', () => {
  it('has the stable subject and maps failingItems keys to human labels', async () => {
    const out = getEmailTemplate('expert-searchability-lost', {
      recipientName: 'Dana',
      failingItems: ['calendar', 'payouts'],
    });
    expect(out.subject).toBe("You've stopped appearing in Balo search");
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Dana,');
    expect(html).toContain('connect a calendar');
    expect(html).toContain('set up payouts');
  });

  it('greets "there" when the recipient name is absent', async () => {
    const out = getEmailTemplate('expert-searchability-lost', { failingItems: ['rate'] });
    const html = clean(await render(out.component));
    expect(html).toContain('Hi there,');
  });

  it('degrades gracefully when failingItems is absent (defensive — never happens in practice)', async () => {
    const out = getEmailTemplate('expert-searchability-lost', { recipientName: 'Dana' });
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Dana,');
  });
});
