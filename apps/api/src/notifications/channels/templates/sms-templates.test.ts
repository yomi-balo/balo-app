import { afterEach, describe, it, expect, vi } from 'vitest';
import { getSmsTemplate, listSmsTemplates } from './sms-templates.js';

describe('getSmsTemplate', () => {
  it('returns correct text for booking-reminder-sms', () => {
    const result = getSmsTemplate('booking-reminder-sms', {});
    expect(result).toBe('Balo: Reminder - your consultation starts in 30 min. Join at balo.expert');
  });

  it('throws for unknown template name', () => {
    expect(() => getSmsTemplate('nonexistent', {})).toThrow('Unknown SMS template: nonexistent');
  });

  // Item 11 — iterates the REGISTERED set (`listSmsTemplates()`), never a hand-maintained
  // literal array. A frozen array silently stops covering every template added after it; this
  // now re-covers itself the moment a new entry joins `sms-templates.ts`'s registry.
  it('all registered templates produce output under 160 characters', () => {
    const templateNames = listSmsTemplates();
    expect(templateNames.length).toBeGreaterThan(0);
    const sampleData = {
      expertName: 'Alexandra Johnson',
      date: 'Mar 25 at 2:00 PM AEDT',
      callerCompanyName: 'Northwind Industrial',
      callerFirstName: 'Alexandra',
      callCaseTitle: 'x'.repeat(200),
      ringId: '3f2b8c1e-5d4a-4e7b-9c1d-0a6b7c8d9e0f',
      meetingId: '3f2b8c1e-5d4a-4e7b-9c1d-0a6b7c8d9e0f',
      scheduledStartIso: '2026-11-19T10:00:00.000Z',
      recipientTimeZone: 'Australia/Sydney',
      waitingPartyName: 'x'.repeat(100),
    };

    for (const name of templateNames) {
      const result = getSmsTemplate(name, sampleData);
      expect(result.length).toBeLessThanOrEqual(160);
    }
  });

  it('listSmsTemplates includes the new reschedule-proposal-sent-sms arm', () => {
    expect(listSmsTemplates()).toContain('reschedule-proposal-sent-sms');
  });

  describe('Call now ring SMS (BAL-652)', () => {
    const RING_ID = '3f2b8c1e-5d4a-4e7b-9c1d-0a6b7c8d9e0f';

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('names the client company to an expert, verbatim from the copy sheet', () => {
      vi.stubEnv('APP_URL', 'https://balo.expert');
      expect(
        getSmsTemplate('call-ringing-sms-expert', {
          callerCompanyName: 'Northwind Industrial',
          callCaseTitle: 'Flow migration',
          ringId: RING_ID,
        })
      ).toBe(
        `Balo: Northwind Industrial is calling you now about "Flow migration". Join: https://balo.expert/call-now/${RING_ID}`
      );
    });

    it('names the expert first name to a client, verbatim from the copy sheet', () => {
      vi.stubEnv('APP_URL', 'https://balo.expert');
      expect(
        getSmsTemplate('call-ringing-sms-client', {
          callerFirstName: 'Sandy',
          callCaseTitle: 'Flow migration',
          ringId: RING_ID,
        })
      ).toBe(
        `Balo: Sandy is calling you now about "Flow migration". Join: https://balo.expert/call-now/${RING_ID}`
      );
    });

    it('links through APP_URL', () => {
      vi.stubEnv('APP_URL', 'https://app.example.test');
      const body = getSmsTemplate('call-ringing-sms-client', { ringId: RING_ID });
      expect(body).toContain(`https://app.example.test/call-now/${RING_ID}`);
    });

    it('uses the origin alone when the ring id is missing', () => {
      vi.stubEnv('APP_URL', 'https://balo.expert');
      const body = getSmsTemplate('call-ringing-sms-client', { callerFirstName: 'Sandy' });
      expect(body.endsWith('Join: https://balo.expert')).toBe(true);
    });

    it('falls back to neutral party names and "your case"', () => {
      expect(getSmsTemplate('call-ringing-sms-expert', { ringId: RING_ID })).toContain(
        'Your client is calling you now about "your case"'
      );
      expect(getSmsTemplate('call-ringing-sms-client', { ringId: RING_ID })).toContain(
        'Your expert is calling you now about "your case"'
      );
    });

    it.each(['call-ringing-sms-expert', 'call-ringing-sms-client'])(
      '%s stays within 160 characters with a 200-character case title, truncating with ASCII dots',
      (name) => {
        vi.stubEnv('APP_URL', 'https://balo.expert');
        const body = getSmsTemplate(name, {
          callerCompanyName: 'Northwind Industrial',
          callerFirstName: 'Sandy',
          callCaseTitle: 'a'.repeat(200),
          ringId: RING_ID,
        });
        expect(body.length).toBeLessThanOrEqual(160);
        expect(body).toContain('...". Join: ');
        expect(body).not.toContain('…');
      }
    );

    it('keeps a title that already fits untouched', () => {
      const body = getSmsTemplate('call-ringing-sms-client', {
        callerFirstName: 'Sandy',
        callCaseTitle: 'Short title',
        ringId: RING_ID,
      });
      expect(body).toContain('"Short title"');
    });

    it('keeps ten characters of the title when even that cannot fit', () => {
      vi.stubEnv('APP_URL', `https://${'h'.repeat(120)}.example.test`);
      const body = getSmsTemplate('call-ringing-sms-client', {
        callerFirstName: 'Sandy',
        callCaseTitle: 'abcdefghijklmnopqrstuvwxyz',
        ringId: RING_ID,
      });
      expect(body).toContain('"abcdefghij..."');
    });

    it('trims a trailing slash on APP_URL and ignores a blank one outside production', () => {
      vi.stubEnv('APP_URL', 'https://app.example.test/');
      expect(getSmsTemplate('call-ringing-sms-client', { ringId: RING_ID })).toContain(
        `Join: https://app.example.test/call-now/${RING_ID}`
      );

      vi.stubEnv('APP_URL', '  ');
      expect(getSmsTemplate('call-ringing-sms-client', { ringId: RING_ID })).toContain(
        `Join: http://localhost:3000/call-now/${RING_ID}`
      );
    });

    it('fails closed in production when APP_URL is unset', () => {
      vi.stubEnv('APP_URL', '');
      vi.stubEnv('NODE_ENV', 'production');
      expect(() => getSmsTemplate('call-ringing-sms-client', { ringId: RING_ID })).toThrow(
        'APP_URL is not set'
      );
    });

    describe('sanitising interpolated values', () => {
      const GSM7_SHAPE = /^[\x20-\x7E£¥èéùìòÇØøÅåÆæßÉ¡ÄÖÑÜ§¿äöñüà¤]*$/;

      function render(overrides: Record<string, unknown>): string {
        vi.stubEnv('APP_URL', 'https://balo.expert');
        return getSmsTemplate('call-ringing-sms-client', {
          callerFirstName: 'Sandy',
          callCaseTitle: 'Flow migration',
          ringId: RING_ID,
          ...overrides,
        });
      }

      it('keeps an emoji and smart-quote title within 160 characters and GSM-7', () => {
        const body = render({
          callCaseTitle: `${'“Quarterly” — launch 🚀 plan… '.repeat(8)}`,
        });
        expect(body.length).toBeLessThanOrEqual(160);
        expect(body).toMatch(GSM7_SHAPE);
        expect(body).not.toContain('—');
        expect(body).toContain("'Quarterly' - launch plan...");
      });

      it('maps smart quotes and dashes to ASCII and swaps double quotes for single', () => {
        const body = render({ callCaseTitle: 'Sandy’s "big" fix – now' });
        expect(body).toContain(`"Sandy's 'big' fix - now"`);
      });

      it('neutralises newlines and URL schemes in a title', () => {
        const body = render({ callCaseTitle: 'Pay now\r\nhttps://evil.example/x\thttp://a.b' });
        expect(body).toContain('"Pay now evil example/x a b"');
        expect(body).not.toContain('://evil');
        expect(body).not.toMatch(/[\r\n\t]/);
      });

      it('strips a nested scheme that would reassemble after one pass', () => {
        const body = render({ callCaseTitle: 'hthttps://tp://evil.example' });
        expect(body).toContain('"evil example"');
        expect(body.replace(/Join: https:\/\//, '')).not.toContain('://');
      });

      it('sanitises the company and first name too', () => {
        vi.stubEnv('APP_URL', 'https://balo.expert');
        const expert = getSmsTemplate('call-ringing-sms-expert', {
          callerCompanyName: 'North’wind\n🚀 https://x.test',
          callCaseTitle: 'Case',
          ringId: RING_ID,
        });
        expect(expert).toContain("Balo: North'wind x test is calling you now");
        expect(expert).toMatch(GSM7_SHAPE);
      });

      it('falls back to the neutral name or title when nothing printable survives', () => {
        const body = render({ callerFirstName: '🚀', callCaseTitle: '\n\t' });
        expect(body).toContain('Balo: Your expert is calling you now about "your case"');
      });

      it.each([
        ['call-ringing-sms-expert', 'callerCompanyName'],
        ['call-ringing-sms-client', 'callerFirstName'],
      ])(
        '%s caps a 200-char caller at 28 with ASCII dots, within 160 and GSM-7 on a long origin',
        (name, key) => {
          vi.stubEnv('APP_URL', 'https://app.staging.balo.expert');
          const body = getSmsTemplate(name, {
            [key]: 'Northwind '.repeat(20),
            callCaseTitle: 'Quarterly launch plan '.repeat(10),
            ringId: RING_ID,
          });
          expect(body.length).toBeLessThanOrEqual(160);
          expect(body).toMatch(GSM7_SHAPE);
          const caller = /^Balo: (.*) is calling you now/.exec(body)?.[1] ?? '';
          expect(caller.length).toBeLessThanOrEqual(28);
          expect(caller.endsWith('...')).toBe(true);
        }
      );

      it('leaves a caller of exactly 28 characters untouched', () => {
        const name = 'A'.repeat(28);
        expect(render({ callerFirstName: name })).toContain(`Balo: ${name} is calling`);
      });

      it('keeps GSM-7 accented letters', () => {
        expect(render({ callerFirstName: 'Zoé' })).toContain('Balo: Zoé is calling');
        expect(render({ callerFirstName: 'Müller' })).toContain('Balo: Müller is calling');
      });

      it.each([
        ['João', 'Joao'],
        ['Zoë', 'Zoe'],
      ])('transliterates %s to %s instead of dropping the letter', (name, expected) => {
        const body = render({ callerFirstName: name });
        expect(body).toContain(`Balo: ${expected} is calling`);
        expect(body).toMatch(GSM7_SHAPE);
      });
    });

    it('registers both keys', () => {
      expect(listSmsTemplates()).toEqual(
        expect.arrayContaining(['call-ringing-sms-expert', 'call-ringing-sms-client'])
      );
    });
  });
  describe('waiting-party SMS (BAL-654)', () => {
    const MEETING_ID = '3f2b8c1e-5d4a-4e7b-9c1d-0a6b7c8d9e0f';
    const BASE = {
      meetingId: MEETING_ID,
      scheduledStartIso: '2026-11-19T10:00:00.000Z',
      recipientTimeZone: 'Australia/Sydney',
    };

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('names the expert first name to a client, verbatim from the copy sheet', () => {
      vi.stubEnv('APP_URL', 'https://balo.expert');
      expect(
        getSmsTemplate('meeting-waiting-sms-client', { ...BASE, waitingPartyName: 'Sandy' })
      ).toBe(
        `Balo: Sandy is waiting in your 21:00 consultation. Join: https://balo.expert/meetings/${MEETING_ID}/call`
      );
    });

    it('names the client company to an expert, verbatim from the copy sheet', () => {
      vi.stubEnv('APP_URL', 'https://balo.expert');
      expect(
        getSmsTemplate('meeting-waiting-sms-expert', {
          ...BASE,
          waitingPartyName: 'Northwind Industrial',
        })
      ).toBe(
        `Balo: Northwind Industrial is waiting in your 21:00 consultation. Join: https://balo.expert/meetings/${MEETING_ID}/call`
      );
    });

    it.each([
      ['meeting-waiting-sms-client', 'Sandy'],
      ['meeting-waiting-sms-expert', 'Northwind Industrial'],
    ])('%s leaves the time out when the recipient has no usable zone', (template, name) => {
      vi.stubEnv('APP_URL', 'https://balo.expert');
      expect(
        getSmsTemplate(template, { ...BASE, recipientTimeZone: null, waitingPartyName: name })
      ).toBe(
        `Balo: ${name} is waiting in your consultation. Join: https://balo.expert/meetings/${MEETING_ID}/call`
      );
    });

    it.each([
      ['meeting-waiting-sms-client', 'Your expert'],
      ['meeting-waiting-sms-expert', 'Your client'],
    ])('%s falls back to a neutral name', (template, fallback) => {
      expect(getSmsTemplate(template, { ...BASE, waitingPartyName: null })).toContain(
        `Balo: ${fallback} is waiting`
      );
      expect(getSmsTemplate(template, { ...BASE, waitingPartyName: '\u{1F600}' })).toContain(
        `Balo: ${fallback} is waiting`
      );
    });

    it.each([
      ['meeting-waiting-sms-client', 'evil.com'],
      ['meeting-waiting-sms-expert', 'Acme.io Pty'],
    ])('%s breaks a bare domain in the name so phones do not auto-link it', (template, name) => {
      const body = getSmsTemplate(template, { ...BASE, waitingPartyName: name });

      expect(body.split(' is waiting')[0]).toBe(`Balo: ${name.replace('.', ' ')}`);
    });

    it('breaks a bare domain in the ring SMS names too, and keeps a sentence-ending full stop', () => {
      vi.stubEnv('APP_URL', 'https://balo.expert');
      const ring = getSmsTemplate('call-ringing-sms-expert', {
        callerCompanyName: 'evil.com',
        callCaseTitle: 'Fix it. Now',
        ringId: 'r1',
      });

      expect(ring).toContain('Balo: evil com is calling you now about "Fix it. Now".');
    });

    it('formats the time in the recipient zone', () => {
      expect(
        getSmsTemplate('meeting-waiting-sms-client', {
          ...BASE,
          recipientTimeZone: 'Australia/Sydney',
        })
      ).toContain('your 21:00 consultation');
    });

    it.each([null, undefined, 42, '', '  ', 'Not/AZone', 'UTC', 'Etc/UTC'])(
      'omits the time, never shows UTC, for the zone %s',
      (zone) => {
        const body = getSmsTemplate('meeting-waiting-sms-client', {
          ...BASE,
          recipientTimeZone: zone,
        });

        expect(body).toContain('is waiting in your consultation. Join: ');
        expect(body).not.toMatch(/\d{2}:\d{2}/);
      }
    );

    it('omits the time rather than throwing on an unreadable start', () => {
      expect(
        getSmsTemplate('meeting-waiting-sms-client', { ...BASE, scheduledStartIso: 'nope' })
      ).toContain('is waiting in your consultation. Join: ');
    });

    it('uses the origin alone when the meeting id is missing', () => {
      vi.stubEnv('APP_URL', 'https://balo.expert');
      expect(
        getSmsTemplate('meeting-waiting-sms-client', { ...BASE, meetingId: undefined })
      ).toMatch(/Join: https:\/\/balo\.expert$/);
    });

    it.each([
      ['meeting-waiting-sms-client', 'Australia/Sydney'],
      ['meeting-waiting-sms-client', null],
      ['meeting-waiting-sms-expert', 'Australia/Sydney'],
      ['meeting-waiting-sms-expert', null],
    ])('%s stays within 160 characters with the zone %s', (template, zone) => {
      vi.stubEnv('APP_URL', 'https://app.staging.balo.expert');

      const body = getSmsTemplate(template, {
        ...BASE,
        recipientTimeZone: zone,
        waitingPartyName: 'N'.repeat(100),
      });

      expect(body.length).toBeLessThanOrEqual(160);
    });

    it('keeps a 60-character name and a 31-character origin within 160 characters', () => {
      vi.stubEnv('APP_URL', 'https://app.staging.balo.expert');
      const body = getSmsTemplate('meeting-waiting-sms-expert', {
        ...BASE,
        waitingPartyName: 'N'.repeat(60),
      });

      expect(body.length).toBeLessThanOrEqual(160);
      expect(body).toContain(`${'N'.repeat(23)}...`);
    });

    it('registers both keys', () => {
      expect(listSmsTemplates()).toEqual(
        expect.arrayContaining(['meeting-waiting-sms-client', 'meeting-waiting-sms-expert'])
      );
    });
  });
});
