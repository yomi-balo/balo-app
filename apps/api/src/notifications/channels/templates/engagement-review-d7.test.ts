import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { ReviewReminderEmail } from './engagement-review-reminder.js';
import { AutoAcceptedEmail } from './engagement-auto-accepted.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

const BASE = 'https://app.balo.expert';
const ENGAGEMENT_URL = `${BASE}/engagements/eng-1`;

const reminderProps = (over: Record<string, unknown> = {}) => ({
  firstName: 'Dana',
  clientCompany: 'Northwind Industrial',
  expertParty: 'CloudPeak Consulting',
  projectTitle: 'CPQ implementation',
  milestonesTotal: 4,
  requestedDate: '4 Jul',
  autoDate: '11 Jul',
  daysLeft: 2,
  engagementUrl: ENGAGEMENT_URL,
  ...over,
});

const autoProps = (over: Record<string, unknown> = {}) => ({
  firstName: 'Dana',
  clientCompany: 'Northwind Industrial',
  expertParty: 'CloudPeak Consulting',
  projectTitle: 'CPQ implementation',
  milestonesTotal: 4,
  requestedDate: '4 Jul',
  autoDate: '11 Jul',
  reviewDays: 7,
  engagementUrl: ENGAGEMENT_URL,
  ...over,
});

describe('ReviewReminderEmail (BAL-338, VARIANT 2)', () => {
  it('renders the friendly-nudge framing, the window block, dual CTA, and one-nudge promise', async () => {
    const html = await render(ReviewReminderEmail(reminderProps()));
    expect(html).toContain('Your completed project is waiting');
    expect(html).toContain('All 4 milestones are done');
    expect(html).toContain('2 days to go');
    expect(html).toContain('close it out as delivered automatically');
    expect(html).toContain('We keep nudges to just this one');
    expect(html).toContain(`${ENGAGEMENT_URL}?action=accept`);
    expect(html).toContain(`${ENGAGEMENT_URL}?action=request-changes`);
  });

  it('pluralises daysLeft (never "1 days")', async () => {
    const html = await render(ReviewReminderEmail(reminderProps({ daysLeft: 1 })));
    expect(html).toContain('1 day to go');
    expect(html).not.toContain('1 days to go');
  });

  it('reads naturally at zero milestones (retainer seam)', async () => {
    const html = await render(ReviewReminderEmail(reminderProps({ milestonesTotal: 0 })));
    expect(html).not.toContain('0 milestones');
    expect(html).toContain('the finish line is a click away');
  });
});

describe('AutoAcceptedEmail (BAL-338, VARIANT 3)', () => {
  it('congratulates, states it closed out as delivered, and shows the green what-happens-now block', async () => {
    const html = await render(AutoAcceptedEmail(autoProps()));
    expect(html).toContain('Congratulations');
    expect(html).toContain('closed the project out as delivered');
    expect(html).toContain('All 4 milestones were delivered along the way');
    expect(html).toContain('What happens now');
    expect(html).toContain('View the project');
    expect(html).toContain('closing the project doesn');
  });

  it('falls back to "Your project is complete" for a long title', async () => {
    const longTitle = 'CPQ implementation to replace the legacy quoting tool across all regions';
    const html = await render(AutoAcceptedEmail(autoProps({ projectTitle: longTitle })));
    expect(html).toContain('Your project is complete');
  });

  it('reads naturally at zero milestones', async () => {
    const html = await render(AutoAcceptedEmail(autoProps({ milestonesTotal: 0 })));
    expect(html).not.toContain('0 milestones');
  });
});

describe('getEmailTemplate — BAL-338 D7 emails', () => {
  it('accepted-expert: subject names the accepting person + project', () => {
    const out = getEmailTemplate('engagement-accepted-expert', {
      recipientName: 'Priya',
      actorClientLabel: 'Dana @ Northwind Industrial',
      projectTitle: 'CPQ implementation',
      acceptedOn: '11 Jul 2026',
      milestonesTotal: 4,
      engagementId: 'eng-1',
    });
    expect(out.subject).toBe('Dana @ Northwind Industrial accepted CPQ implementation 🎉');
    expect(out.component).toBeDefined();
  });

  it('accepted-admin: the stable "Ready to invoice" money subject', async () => {
    const out = getEmailTemplate('engagement-accepted-admin', {
      recipientName: 'MJ',
      actorClientLabel: 'Dana @ Northwind Industrial',
      projectTitle: 'CPQ implementation',
      engagementId: 'eng-1',
    });
    expect(out.subject).toBe('Ready to invoice: final installment — CPQ implementation');
    const html = await render(out.component);
    expect(html).toContain('Dana @ Northwind Industrial accepted the project.');
    expect(html).toContain('ready to invoice');
  });

  it('changes-requested-expert: subject + verbatim note + window-restarts copy', async () => {
    const out = getEmailTemplate('engagement-changes-requested-expert', {
      recipientName: 'Priya',
      actorClientLabel: 'Dana @ Northwind Industrial',
      projectTitle: 'CPQ implementation',
      note: 'The report export is missing the Q3 totals.',
      reviewDays: 7,
      engagementId: 'eng-1',
    });
    expect(out.subject).toBe('Dana @ Northwind Industrial requested changes on CPQ implementation');
    const html = await render(out.component);
    expect(html).toContain('The report export is missing the Q3 totals.');
    expect(html).toContain('review window restarts');
  });

  it('auto-accepted-client: the VARIANT 3 email, "is complete" subject', () => {
    const out = getEmailTemplate('engagement-auto-accepted-client', {
      recipientName: 'Dana',
      clientCompanyName: 'Northwind Industrial',
      expertPartyLabel: 'CloudPeak Consulting',
      projectTitle: 'CPQ implementation',
      milestonesTotal: 4,
      requestedDate: '4 Jul',
      autoDate: '11 Jul',
      reviewDays: 7,
      engagementId: 'eng-1',
    });
    expect(out.subject).toBe('CPQ implementation is complete 🎉');
  });

  it('auto-accepted-expert: congrats email, "is complete" subject', async () => {
    const out = getEmailTemplate('engagement-auto-accepted-expert', {
      recipientName: 'Priya',
      clientCompanyName: 'Northwind Industrial',
      projectTitle: 'CPQ implementation',
      autoDate: '11 Jul',
      engagementId: 'eng-1',
    });
    expect(out.subject).toBe('CPQ implementation is complete 🎉');
    const html = await render(out.component);
    expect(html).toContain('closed out as delivered');
  });

  it('auto-accepted-admin: stable money subject, auto path in the body', async () => {
    const out = getEmailTemplate('engagement-auto-accepted-admin', {
      recipientName: 'MJ',
      projectTitle: 'CPQ implementation',
      reviewDays: 7,
      engagementId: 'eng-1',
    });
    expect(out.subject).toBe('Ready to invoice: final installment — CPQ implementation');
    const html = await render(out.component);
    expect(html).toContain('accepted automatically (7-day review window)');
  });

  it('review-reminder-client: the VARIANT 2 email, "waiting" subject', () => {
    const out = getEmailTemplate('engagement-review-reminder-client', {
      recipientName: 'Dana',
      clientCompanyName: 'Northwind Industrial',
      expertPartyLabel: 'CloudPeak Consulting',
      projectTitle: 'CPQ implementation',
      milestonesTotal: 4,
      requestedDate: '4 Jul',
      autoDate: '11 Jul',
      daysLeft: 2,
      engagementId: 'eng-1',
    });
    expect(out.subject).toBe('Your completed project is waiting — CPQ implementation');
  });
});

describe('getInAppTemplate — BAL-338 D7 factories', () => {
  const engagementId = 'eng-1';

  it('accepted-expert → congrats, deep-linked to the workspace', () => {
    const out = getInAppTemplate('engagement-accepted-expert', {
      actorClientLabel: 'Dana @ Northwind Industrial',
      projectTitle: 'CPQ implementation',
      engagementId,
    });
    expect(out.title).toBe('Project accepted 🎉');
    expect(out.body).toContain('Dana @ Northwind Industrial accepted');
    expect(out.actionUrl).toBe('/engagements/eng-1');
  });

  it('accepted-admin → money signal', () => {
    const out = getInAppTemplate('engagement-accepted-admin', {
      actorClientLabel: 'Dana @ Northwind Industrial',
      projectTitle: 'CPQ implementation',
      engagementId,
    });
    expect(out.title).toBe('Ready to invoice: final installment');
    expect(out.body).toContain('ready to invoice');
  });

  it('changes-requested-expert → active-again nudge', () => {
    const out = getInAppTemplate('engagement-changes-requested-expert', {
      actorClientLabel: 'Dana @ Northwind Industrial',
      projectTitle: 'CPQ implementation',
      engagementId,
    });
    expect(out.title).toBe('Changes requested');
    expect(out.body).toContain('the project is active again');
  });

  it('changes-requested-admin → review-cycle ops signal', () => {
    const out = getInAppTemplate('engagement-changes-requested-admin', {
      actorClientLabel: 'Dana @ Northwind Industrial',
      projectTitle: 'CPQ implementation',
      reviewCycle: 2,
      engagementId,
    });
    expect(out.body).toContain('(review cycle 2)');
  });

  it('auto-accepted-client → wrapped-up-as-delivered', () => {
    const out = getInAppTemplate('engagement-auto-accepted-client', {
      projectTitle: 'CPQ implementation',
      engagementId,
    });
    expect(out.title).toBe('Project complete 🎉');
    expect(out.body).toContain('wrapped up as delivered after the review window');
  });

  it('auto-accepted-expert → closed-out on the auto date', () => {
    const out = getInAppTemplate('engagement-auto-accepted-expert', {
      projectTitle: 'CPQ implementation',
      autoDate: '11 Jul',
      engagementId,
    });
    expect(out.body).toContain('closed out as delivered on 11 Jul');
  });

  it('auto-accepted-admin → money signal with the auto window', () => {
    const out = getInAppTemplate('engagement-auto-accepted-admin', {
      projectTitle: 'CPQ implementation',
      reviewDays: 7,
      engagementId,
    });
    expect(out.title).toBe('Ready to invoice: final installment');
    expect(out.body).toContain('accepted automatically (7-day window)');
  });

  it('review-reminder-client → one friendly nudge with the auto date', () => {
    const out = getInAppTemplate('engagement-review-reminder-client', {
      projectTitle: 'CPQ implementation',
      autoDate: '11 Jul',
      engagementId,
    });
    expect(out.title).toBe('Your completed project is waiting 👋');
    expect(out.body).toContain('wraps up as delivered on 11 Jul');
    expect(out.actionUrl).toBe('/engagements/eng-1');
  });
});
