import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { CompletionRequestEmail } from './engagement-completion-requested.js';
import { EngagementCancelledEmail } from './engagement-cancelled.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

const BASE = 'https://app.balo.expert';

describe('CompletionRequestEmail (BAL-334, VARIANT 1)', () => {
  it('renders the actor, project, counts, dates, window block, and the dual review CTAs', async () => {
    const html = await render(
      CompletionRequestEmail({
        firstName: 'Dana',
        clientCompany: 'Northwind Industrial',
        expertParty: 'CloudPeak Consulting',
        actorExpert: 'Priya @ CloudPeak',
        projectTitle: 'CPQ implementation',
        milestonesTotal: 4,
        requestedDate: '4 Jul',
        autoDate: '11 Jul',
        reviewDays: 7,
        engagementUrl: `${BASE}/engagements/eng-1`,
      })
    );
    // Celebratory hero + prospective party naming.
    expect(html).toContain('Your project is complete!');
    expect(html).toContain('CloudPeak Consulting');
    // Retrospective actor + the marked-complete date.
    expect(html).toContain('Priya @ CloudPeak');
    expect(html).toContain('4 Jul');
    // The signature window block keeps the auto-accept date unmissable. (react-email
    // injects `<!-- -->` markers around interpolations, so assert the contiguous parts.)
    expect(html).toContain('The final step');
    expect(html).toContain('Take until');
    expect(html).toContain('11 Jul');
    expect(html).toContain('no rush');
    expect(html).toContain('Northwind Industrial');
    // Both decision CTAs deep-link to the delivery workspace with the D7 action params.
    expect(html).toContain('/engagements/eng-1?action=accept');
    expect(html).toContain('/engagements/eng-1?action=request-changes');
    expect(html).toContain('Accept project');
    expect(html).toContain('Request changes');
  });
});

describe('EngagementCancelledEmail (BAL-334)', () => {
  it('renders the cancellation date and the recorded reason verbatim', async () => {
    const html = await render(
      EngagementCancelledEmail({
        firstName: 'Dana',
        projectTitle: 'CPQ implementation',
        cancelledOn: '9 Jul 2026',
        reason: 'Client changed direction.',
        baseUrl: BASE,
      })
    );
    expect(html).toContain('This engagement has been cancelled.');
    expect(html).toContain('Balo cancelled the engagement on 9 Jul 2026.');
    // The recorded reason renders verbatim in its own callout.
    expect(html).toContain('Client changed direction.');
    expect(html).toContain('Reply to this email or message Balo with any questions.');
  });
});

describe('getEmailTemplate — BAL-334 lifecycle emails', () => {
  it('completion-requested-client builds the celebratory subject naming the project', () => {
    const result = getEmailTemplate('engagement-completion-requested-client', {
      recipientName: 'Dana',
      clientCompanyName: 'Northwind Industrial',
      expertPartyLabel: 'CloudPeak Consulting',
      actorExpertLabel: 'Priya @ CloudPeak',
      projectTitle: 'CPQ implementation',
      milestonesTotal: 4,
      requestedDate: '4 Jul',
      autoDate: '11 Jul',
      reviewDays: 7,
      engagementId: 'eng-1',
    });
    expect(result.subject).toBe('Great news — CPQ implementation is complete 🎉');
    expect(result.component).toBeDefined();
  });

  it('cancelled builds the subject naming the project', () => {
    const result = getEmailTemplate('engagement-cancelled', {
      recipientName: 'Priya',
      projectTitle: 'CPQ implementation',
      cancelledOn: '9 Jul 2026',
      reason: 'Client changed direction.',
    });
    expect(result.subject).toBe('CPQ implementation has been cancelled');
    expect(result.component).toBeDefined();
  });
});

describe('getInAppTemplate — BAL-334 lifecycle factories', () => {
  it('completion-requested-client → celebratory body with the auto-accept date + workspace link', () => {
    const out = getInAppTemplate('engagement-completion-requested-client', {
      actorExpertLabel: 'Priya',
      projectTitle: 'CPQ implementation',
      autoDate: '11 Jul',
      engagementId: 'eng-1',
    });
    expect(out.title).toBe('Project complete — review it');
    expect(out.body).toBe(
      "Priya marked 'CPQ implementation' complete 🎉 — take a look and make it official. Closes out as delivered on 11 Jul if no one responds."
    );
    expect(out.actionUrl).toBe('/engagements/eng-1');
  });

  it('completion-requested-admin → project-scoped ops signal with the auto-accept date', () => {
    const out = getInAppTemplate('engagement-completion-requested-admin', {
      projectTitle: 'CPQ implementation',
      clientCompanyName: 'Northwind Industrial',
      autoDate: '11 Jul',
      engagementId: 'eng-1',
    });
    expect(out.title).toBe('Sent for review');
    expect(out.body).toBe(
      'CPQ implementation sent for Northwind Industrial review — auto-accepts 11 Jul.'
    );
    expect(out.actionUrl).toBe('/engagements/eng-1');
  });

  it('completion-withdrawn → shared client + admin body', () => {
    const out = getInAppTemplate('engagement-completion-withdrawn', {
      actorExpertLabel: 'Priya',
      projectTitle: 'CPQ implementation',
      engagementId: 'eng-1',
    });
    expect(out.title).toBe('Back to active');
    expect(out.body).toBe(
      'Priya withdrew the completion request on CPQ implementation — the project is active again.'
    );
    expect(out.actionUrl).toBe('/engagements/eng-1');
  });

  it('cancelled → shared client + expert body with the cancellation date', () => {
    const out = getInAppTemplate('engagement-cancelled', {
      projectTitle: 'CPQ implementation',
      cancelledOn: '9 Jul 2026',
      engagementId: 'eng-1',
    });
    expect(out.title).toBe('Engagement cancelled');
    expect(out.body).toBe(
      'CPQ implementation has been cancelled. Balo cancelled the engagement on 9 Jul 2026.'
    );
    expect(out.actionUrl).toBe('/engagements/eng-1');
  });

  it('falls back gracefully when optional fields are absent', () => {
    const client = getInAppTemplate('engagement-completion-requested-client', {
      engagementId: 'eng-1',
    });
    expect(client.body).toBe(
      "Your expert marked 'your project' complete 🎉 — take a look and make it official. Closes out as delivered on the review deadline if no one responds."
    );
    const withdrawn = getInAppTemplate('engagement-completion-withdrawn', {});
    expect(withdrawn.body).toBe(
      'The expert withdrew the completion request on the project — the project is active again.'
    );
    expect(withdrawn.actionUrl).toBeUndefined();
  });
});
