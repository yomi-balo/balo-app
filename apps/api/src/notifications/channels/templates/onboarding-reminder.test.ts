import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { OnboardingReminderEmail } from './onboarding-reminder.js';
import { getEmailTemplate } from './index.js';

const BASE = 'https://app.balo.expert';

const props = (over: Record<string, unknown> = {}) => ({
  firstName: 'Dana',
  ctaUrl: `${BASE}/onboarding?src=onboarding_reminder&step=1`,
  baseUrl: BASE,
  ...over,
});

/**
 * Normalise React-Email output: strip the `<!-- -->` markers it inserts around
 * interpolated text, and un-escape `&amp;` so query-string assertions read naturally.
 */
function clean(html: string): string {
  return html.replaceAll('<!-- -->', '').replaceAll('&amp;', '&');
}

describe('OnboardingReminderEmail (BAL-374)', () => {
  it('greets by first name and links the CTA to the reminder onboarding URL', async () => {
    const html = clean(await render(OnboardingReminderEmail(props())));
    expect(html).toContain('Hi Dana,');
    expect(html).toContain('Pick up where you left off');
    expect(html).toContain('Finish setting up');
    expect(html).toContain(`${BASE}/onboarding?src=onboarding_reminder&step=1`);
  });

  it('falls back to the "there" greeting for a name-less recipient', async () => {
    const html = clean(await render(OnboardingReminderEmail(props({ firstName: 'there' }))));
    expect(html).toContain('Hi there,');
  });

  it('names no org / company / workspace (org-less recipient)', async () => {
    const html = await render(OnboardingReminderEmail(props()));
    expect(html).not.toMatch(/\b(organi[sz]ation|company|workspace|team)\b/i);
  });

  it('uses no deadline / countdown / pressure framing (recovery, not safety)', async () => {
    const html = await render(OnboardingReminderEmail(props()));
    expect(html).not.toMatch(
      /deadline|expires?|countdown|last chance|hurry|act now|final reminder/i
    );
    // The warm "no rush" reassurance is present instead.
    expect(html).toContain('no rush');
  });
});

describe('getEmailTemplate — onboarding-reminder factory', () => {
  it('has the stable subject and builds the step-parameterised CTA', async () => {
    const out = getEmailTemplate('onboarding-reminder', {
      recipientName: 'Dana',
      cadenceStep: 2,
    });
    expect(out.subject).toBe('Finish setting up your Balo account');
    const html = clean(await render(out.component));
    expect(html).toContain('/onboarding?src=onboarding_reminder&step=2');
  });

  it('the subject is identical across all three cadence steps (copy does not vary by step)', () => {
    for (const cadenceStep of [1, 2, 3] as const) {
      const out = getEmailTemplate('onboarding-reminder', { recipientName: 'Dana', cadenceStep });
      expect(out.subject).toBe('Finish setting up your Balo account');
    }
  });

  it('greets "there" and defaults step to 1 when name + step are absent', async () => {
    const out = getEmailTemplate('onboarding-reminder', {});
    const html = clean(await render(out.component));
    expect(html).toContain('Hi there,');
    expect(html).toContain('/onboarding?src=onboarding_reminder&step=1');
  });

  it('clamps an out-of-range cadenceStep to 1', async () => {
    const out = getEmailTemplate('onboarding-reminder', { recipientName: 'Dana', cadenceStep: 9 });
    const html = clean(await render(out.component));
    expect(html).toContain('/onboarding?src=onboarding_reminder&step=1');
  });
});
