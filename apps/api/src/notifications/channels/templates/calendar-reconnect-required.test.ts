import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { CalendarReconnectRequiredEmail } from './calendar-reconnect-required.js';
import { getEmailTemplate } from './index.js';

const BASE = 'https://app.balo.expert';

const props = (over: Record<string, unknown> = {}) => ({
  firstName: 'Dana',
  providerLabel: 'Google Calendar',
  ctaUrl: `${BASE}/expert/settings?tab=schedule`,
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

describe('CalendarReconnectRequiredEmail (BAL-396 §7)', () => {
  it('greets by first name, names the provider, and links the CTA to the calendar settings tab', async () => {
    const html = clean(await render(CalendarReconnectRequiredEmail(props())));
    expect(html).toContain('Hi Dana,');
    expect(html).toContain('Your calendar disconnected');
    expect(html).toContain('Google Calendar');
    expect(html).toContain('Reconnect calendar');
    expect(html).toContain(`${BASE}/expert/settings?tab=schedule`);
  });

  it('falls back to the "there" greeting for a name-less recipient', async () => {
    const html = clean(await render(CalendarReconnectRequiredEmail(props({ firstName: 'there' }))));
    expect(html).toContain('Hi there,');
  });

  it('carries the re-consent recovery line (revoke-at-provider-first)', async () => {
    const html = await render(CalendarReconnectRequiredEmail(props()));
    expect(html).toMatch(/remove it there first before reconnecting/i);
  });

  it('names Microsoft 365 when the provider label says so', async () => {
    const html = clean(
      await render(CalendarReconnectRequiredEmail(props({ providerLabel: 'Microsoft 365' })))
    );
    expect(html).toContain('Microsoft 365');
  });

  it('uses no deadline / countdown / threat framing (a quiet fact, not a threat)', async () => {
    const html = await render(CalendarReconnectRequiredEmail(props()));
    expect(html).not.toMatch(/deadline|expires?|countdown|last chance|hurry|act now|urgent/i);
  });

  it('reassures that profile, rate and past bookings are untouched', async () => {
    const html = await render(CalendarReconnectRequiredEmail(props()));
    expect(html).toMatch(/untouched/i);
  });
});

describe('getEmailTemplate — calendar-reconnect-required factory', () => {
  it('has the stable subject and resolves the Google label', async () => {
    const out = getEmailTemplate('calendar-reconnect-required', {
      recipientName: 'Dana',
      provider: 'google',
    });
    expect(out.subject).toBe('Reconnect your calendar to keep taking bookings');
    const html = clean(await render(out.component));
    expect(html).toContain('Google Calendar');
    expect(html).toContain('Hi Dana,');
  });

  it('resolves the Microsoft 365 label', async () => {
    const out = getEmailTemplate('calendar-reconnect-required', {
      recipientName: 'Dana',
      provider: 'microsoft',
    });
    const html = clean(await render(out.component));
    expect(html).toContain('Microsoft 365');
  });

  /**
   * ⚠ BAL-396 FIX ROUND — THE DOUBLED-NOUN REGRESSION TEST. "your calendar calendar" used
   * to be PINNED as the expected string here — the test asserted the bug rather than
   * catching it. `calendarProviderLabel` now composes the trailing noun itself, so the
   * template's `your {providerLabel}` interpolation can never double it up.
   */
  it('degrades an unrecognised or absent provider to the generic "calendar" noun, with no doubled noun', async () => {
    const out = getEmailTemplate('calendar-reconnect-required', { recipientName: 'Dana' });
    const html = clean(await render(out.component));
    expect(html).toContain('your calendar,');
    expect(html).not.toMatch(/calendar\s+calendar/i);
  });

  it('greets "there" when the recipient name is absent', async () => {
    const out = getEmailTemplate('calendar-reconnect-required', { provider: 'google' });
    const html = clean(await render(out.component));
    expect(html).toContain('Hi there,');
  });
});
