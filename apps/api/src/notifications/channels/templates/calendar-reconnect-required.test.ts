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
  // BAL-414 (D10) — the de-list arm by default; individual tests override to exercise the
  // still-searchable arm.
  stillSearchable: false,
  ...over,
});

/**
 * Normalise React-Email output: strip the `<!-- -->` markers it inserts around
 * interpolated text, and un-escape `&amp;` / `&#x27;` so plain-text assertions (including
 * ones that span an apostrophe, e.g. "won't") read naturally.
 */
function clean(html: string): string {
  return html.replaceAll('<!-- -->', '').replaceAll('&amp;', '&').replaceAll('&#x27;', "'");
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

  it('uses no deadline / countdown / threat framing (a quiet fact, not a threat), on either arm', async () => {
    const deListed = await render(
      CalendarReconnectRequiredEmail(props({ stillSearchable: false }))
    );
    const stillListed = await render(
      CalendarReconnectRequiredEmail(props({ stillSearchable: true }))
    );
    const negative = /deadline|expires?|countdown|last chance|hurry|act now|urgent/i;
    expect(deListed).not.toMatch(negative);
    expect(stillListed).not.toMatch(negative);
  });

  it('reassures that profile, rate and past bookings are untouched, on either arm', async () => {
    const deListed = await render(
      CalendarReconnectRequiredEmail(props({ stillSearchable: false }))
    );
    const stillListed = await render(
      CalendarReconnectRequiredEmail(props({ stillSearchable: true }))
    );
    expect(deListed).toMatch(/untouched/i);
    expect(stillListed).toMatch(/untouched/i);
  });

  // BAL-414 (D10, addendum) — the two arms of the multi-provider fix. `stillSearchable` is the
  // SAME derived value the DB de-list decision used; the template must never claim a search
  // pause for an expert who remains fully searchable (D4 ANY-ACTIVE, a second healthy
  // connection).
  describe('stillSearchable === false (the single/all-providers-broken de-list)', () => {
    it('states the search de-list and the public-profile pause', async () => {
      const html = clean(
        await render(CalendarReconnectRequiredEmail(props({ stillSearchable: false })))
      );
      expect(html).toMatch(/won't appear in Balo search/i);
      expect(html).toMatch(/public profile link is on hold/i);
    });
  });

  describe('stillSearchable === true (a second connection keeps the expert listed)', () => {
    it('does NOT claim a search pause, and names the other calendar covering the listing', async () => {
      const html = clean(
        await render(CalendarReconnectRequiredEmail(props({ stillSearchable: true })))
      );
      expect(html).not.toMatch(/won't appear in Balo search/i);
      expect(html).not.toMatch(/public profile link is on hold/i);
      expect(html).toMatch(/other connected calendar is still covering/i);
    });

    it('still drives the reconnect by naming the invisible-busy-time risk', async () => {
      const html = await render(CalendarReconnectRequiredEmail(props({ stillSearchable: true })));
      expect(html).toMatch(/busy time on it is no longer being checked/i);
    });
  });
});

describe('getEmailTemplate — calendar-reconnect-required factory', () => {
  it('has the de-listed subject and resolves the Google label', async () => {
    const out = getEmailTemplate('calendar-reconnect-required', {
      recipientName: 'Dana',
      provider: 'google',
      stillSearchable: false,
    });
    expect(out.subject).toBe('Reconnect your calendar to appear in search again');
    const html = clean(await render(out.component));
    expect(html).toContain('Google Calendar');
    expect(html).toContain('Hi Dana,');
  });

  // BLOCKER 3 (fix round 1) — the subject must branch exactly as the body does. For the
  // ANY-ACTIVE audience (D4) the expert never left search, so the subject must not assert
  // they did.
  it('branches the subject to the still-searchable wording when stillSearchable is true', async () => {
    const out = getEmailTemplate('calendar-reconnect-required', {
      recipientName: 'Dana',
      provider: 'google',
      stillSearchable: true,
    });
    expect(out.subject).toBe('Reconnect your calendar to keep your availability accurate');
  });

  it('resolves the Microsoft 365 label', async () => {
    const out = getEmailTemplate('calendar-reconnect-required', {
      recipientName: 'Dana',
      provider: 'microsoft',
      stillSearchable: false,
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

  // BAL-414 (D10) — the factory reads `stillSearchable` straight off the merged payload,
  // coercing anything but a literal `true` to `false` (the safe default: claiming a search
  // pause when uncertain is at worst redundant, claiming continued visibility when uncertain
  // would be a false reassurance).
  it('defaults to the de-listed arm when stillSearchable is absent from the payload', async () => {
    const out = getEmailTemplate('calendar-reconnect-required', {
      recipientName: 'Dana',
      provider: 'google',
    });
    const html = clean(await render(out.component));
    expect(html).toMatch(/won't appear in Balo search/i);
  });

  it('renders the still-searchable arm when stillSearchable is true', async () => {
    const out = getEmailTemplate('calendar-reconnect-required', {
      recipientName: 'Dana',
      provider: 'google',
      stillSearchable: true,
    });
    const html = clean(await render(out.component));
    expect(html).toMatch(/other connected calendar is still covering/i);
  });
});
