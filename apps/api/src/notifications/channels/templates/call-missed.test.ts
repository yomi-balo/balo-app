import { describe, expect, it } from 'vitest';
import { render } from '@react-email/render';
import { CallMissedEmail, buildCallMissedCopy, formatCallTimeForRecipient } from './call-missed.js';
import { getEmailTemplate } from './index.js';

const BASE = 'https://app.balo.expert';

/** Strip the React-Email `<!-- -->` interpolation markers so multi-part text reads naturally. */
function clean(html: string): string {
  return html.replaceAll('<!-- -->', '').replaceAll('&amp;', '&').replaceAll('&#x27;', "'");
}

describe('formatCallTimeForRecipient', () => {
  const INSTANT = '2026-11-17T00:41:00.000Z';

  it('renders the recipient zone with its city', () => {
    expect(formatCallTimeForRecipient(INSTANT, 'Australia/Melbourne')).toBe(
      '11:41 (Melbourne time)'
    );
    expect(formatCallTimeForRecipient(INSTANT, 'America/New_York')).toBe('19:41 (New York time)');
  });

  it.each([null, undefined, '', 'UTC', 'Not/AZone'])('falls back to UTC for zone %s', (zone) => {
    expect(formatCallTimeForRecipient(INSTANT, zone)).toBe('00:41 (UTC)');
  });

  it('returns an empty string for an unparseable instant', () => {
    expect(formatCallTimeForRecipient('nope', 'Australia/Melbourne')).toBe('');
  });
});

describe('buildCallMissedCopy', () => {
  const base = {
    callerFirstName: 'Sandy',
    callerCompanyName: 'Northwind Industrial',
    callerPersonLabel: 'Jordan Lee @ Northwind Industrial',
    caseTitle: 'Flow migration',
    time: '10:41 (Melbourne time)',
  };

  it('client copy: the expert first name, nothing charged, call back or book', () => {
    expect(buildCallMissedCopy({ ...base, calleeSide: 'client' })).toEqual({
      subject: 'You missed a call from Sandy',
      body: 'Sandy tried to call you at 10:41 (Melbourne time) about Flow migration. Nothing was charged. Open the case to call back or book a time.',
    });
  });

  it('expert copy: the company in the subject, the person with their company in the body', () => {
    expect(buildCallMissedCopy({ ...base, calleeSide: 'expert' })).toEqual({
      subject: 'You missed a call from Northwind Industrial',
      body: 'Jordan Lee @ Northwind Industrial tried to call you at 10:41 (Melbourne time) about Flow migration. Nothing was counted or charged. Open the case to call back.',
    });
  });

  it('drops the time clause rather than printing an empty one', () => {
    const copy = buildCallMissedCopy({ ...base, calleeSide: 'client', time: '' });
    expect(copy.body.startsWith('Sandy tried to call you about Flow migration.')).toBe(true);
  });

  it('uses no gendered pronoun', () => {
    for (const calleeSide of ['client', 'expert'] as const) {
      const text = ` ${buildCallMissedCopy({ ...base, calleeSide }).body.toLowerCase()} `;
      for (const pronoun of ['he', 'she', 'his', 'her', 'him', 'hers']) {
        expect(text).not.toContain(` ${pronoun} `);
      }
    }
  });
});

describe('CallMissedEmail', () => {
  it('renders the greeting, body and an Open case link to the case', async () => {
    const html = clean(
      await render(
        CallMissedEmail({
          firstName: 'Alex',
          heading: 'You missed a call from Sandy',
          body: 'Sandy tried to call you.',
          caseUrl: `${BASE}/cases/eng-1`,
          baseUrl: BASE,
        })
      )
    );

    expect(html).toContain('You missed a call from Sandy');
    expect(html).toContain('Hi Alex,');
    expect(html).toContain('Sandy tried to call you.');
    expect(html).toContain('Open case');
    expect(html).toContain(`href="${BASE}/cases/eng-1"`);
  });
});

describe('call-missed email templates (registry)', () => {
  const data = {
    recipientName: 'Alex',
    engagementId: 'eng-9',
    callCaseTitle: 'Flow migration',
    callerFirstName: 'Sandy',
    callerCompanyName: 'Northwind Industrial',
    callerPersonLabel: 'Jordan Lee @ Northwind Industrial',
    lastMissedAtIso: '2026-11-17T00:41:00.000Z',
    calleeTimeZone: 'Australia/Melbourne',
    missedCount: 1,
  };

  it('client: subject and body from the copy sheet, CTA to the case', async () => {
    const { component, subject } = getEmailTemplate('call-missed-client', data);
    const html = clean(await render(component));

    expect(subject).toBe('You missed a call from Sandy');
    expect(html).toContain(
      'Sandy tried to call you at 11:41 (Melbourne time) about Flow migration. Nothing was charged.'
    );
    expect(html).toContain('/cases/eng-9');
  });

  it('expert: subject and body from the copy sheet', async () => {
    const { component, subject } = getEmailTemplate('call-missed-expert', data);
    const html = clean(await render(component));

    expect(subject).toBe('You missed a call from Northwind Industrial');
    expect(html).toContain(
      'Jordan Lee @ Northwind Industrial tried to call you at 11:41 (Melbourne time) about Flow migration. Nothing was counted or charged.'
    );
  });

  it('keeps the singular wording with the latest time when several calls were missed', () => {
    const { subject } = getEmailTemplate('call-missed-client', { ...data, missedCount: 3 });
    expect(subject).toBe('You missed a call from Sandy');
  });

  it('degrades to neutral names rather than printing undefined', async () => {
    const { component, subject } = getEmailTemplate('call-missed-client', {});
    const html = clean(await render(component));

    expect(subject).toBe('You missed a call from Your expert');
    expect(html).not.toContain('undefined');
    expect(html).toContain('Hi there,');
  });
});
