import { describe, expect, it } from 'vitest';
import { render } from '@react-email/render';
import { getEmailTemplate } from './index.js';
import { meetingReminderSubject } from './meeting-reminder.js';

const BASE_URL = process.env.APP_URL ?? 'https://balo.expert';

function clean(html: string): string {
  return html
    .replaceAll('<!-- -->', '')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'");
}

/** The message as a human reads it. The tag regex excludes `<` so it stays linear (S5852). */
function textOf(html: string): string {
  return clean(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^<>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BASE_DATA = {
  recipientName: 'Jordan',
  offset: '1h',
  counterpartyName: 'CloudPeak',
  callLabel: 'Consultation',
  scheduledStartIso: '2026-09-01T04:00:00.000Z',
  durationMinutes: 30,
  recipientTimeZone: 'Australia/Sydney',
  joinPath: '/meetings/meeting-456/call',
  reschedulePath: '/cases/case-123',
};

describe.each([
  ['meeting-reminder-client', 'your expert'],
  ['meeting-reminder-expert', 'your client'],
] as const)('getEmailTemplate — %s (BAL-658)', (template, fallback) => {
  it('subject names the call and the counterparty', () => {
    expect(getEmailTemplate(template, BASE_DATA).subject).toBe(
      'Coming up: Consultation with CloudPeak'
    );
  });

  it.each([
    ['24h', 'Your consultation starts in 24 hours'],
    ['1h', 'Your consultation starts in 1 hour'],
  ])('heading for the %s offset', async (offset, heading) => {
    const { component } = getEmailTemplate(template, { ...BASE_DATA, offset });

    expect(textOf(await render(component))).toContain(heading);
  });

  it('body names the call, the time in the recipient zone and where to reschedule', async () => {
    const { component } = getEmailTemplate(template, BASE_DATA);
    const text = textOf(await render(component));

    expect(text).toContain('Hi Jordan,');
    expect(text).toContain('Consultation with CloudPeak starts');
    expect(text).toContain('Rescheduling and cancelling happen in Balo.');
    expect(text).toContain(`Reschedule: ${BASE_URL}/cases/case-123`);
  });

  it.each(['constructor', 'toString', 'nope'])(
    'falls back to the 24h heading for the inherited or unknown offset %s',
    async (offset) => {
      const { component } = getEmailTemplate(template, { ...BASE_DATA, offset });

      expect(textOf(await render(component))).toContain('Your consultation starts in 24 hours');
    }
  );

  it('the subtext makes no claim that the call is joinable yet', async () => {
    const { component } = getEmailTemplate(template, BASE_DATA);
    const text = textOf(await render(component));

    expect(text).toContain('You can join from Balo shortly before the start.');
    expect(text).not.toContain('one tap away');
  });

  it('the CTA joins the call', async () => {
    const { component } = getEmailTemplate(template, BASE_DATA);
    const html = await render(component);

    expect(html).toContain(`href="${BASE_URL}/meetings/meeting-456/call"`);
    expect(textOf(html)).toContain('Join the call');
  });

  it('omits the Reschedule line when the context has no page', async () => {
    const { component } = getEmailTemplate(template, { ...BASE_DATA, reschedulePath: null });
    const text = textOf(await render(component));

    expect(text).not.toContain('Reschedule:');
    expect(text).toContain('Rescheduling and cancelling happen in Balo.');
  });

  it('falls back to the adapter-injected zone when the payload has none', async () => {
    const { component } = getEmailTemplate(template, {
      ...BASE_DATA,
      recipientTimeZone: null,
      recipientTimezone: 'Australia/Sydney',
    });

    expect(textOf(await render(component))).toContain('Sydney time');
  });

  it('renders without a zone label when neither zone is usable', async () => {
    const { component } = getEmailTemplate(template, { ...BASE_DATA, recipientTimeZone: null });

    expect(textOf(await render(component))).not.toContain('Sydney time');
  });

  it('falls back to a name-free counterparty and "Call" when nothing was rebuilt', async () => {
    const data = { ...BASE_DATA, counterpartyName: null, callLabel: null };
    const { component, subject } = getEmailTemplate(template, data);

    expect(subject).toBe(`Coming up: Call with ${fallback}`);
    expect(textOf(await render(component))).toContain(`Call with ${fallback} starts`);
  });

  it('carries no address', async () => {
    const { component, subject } = getEmailTemplate(template, {
      ...BASE_DATA,
      counterpartyEmail: 'sandy@example.com',
    });
    const text = textOf(await render(component)).replace('support@getbalo.com', '');

    expect(subject).not.toContain('@');
    expect(text).not.toContain('@');
    expect(text).not.toContain('sandy');
  });
});

describe('meetingReminderSubject', () => {
  it('treats a blank counterparty as absent', () => {
    expect(meetingReminderSubject('client', 'Consultation', '   ')).toBe(
      'Coming up: Consultation with your expert'
    );
  });
});
