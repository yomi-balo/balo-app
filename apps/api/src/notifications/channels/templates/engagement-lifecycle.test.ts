import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { CompletionRequestEmail, milestonePhrases } from './engagement-completion-requested.js';
import { EngagementCancelledEmail } from './engagement-cancelled.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

const BASE = 'https://app.balo.expert';

// Shared props builder — only `milestonesTotal` varies across the count-copy cases.
const completionProps = (milestonesTotal: number) => ({
  firstName: 'Dana',
  clientCompany: 'Northwind Industrial',
  expertParty: 'CloudPeak Consulting',
  actorExpert: 'Priya @ CloudPeak',
  projectTitle: 'CPQ implementation',
  milestonesTotal,
  requestedDate: '4 Jul',
  autoDate: '11 Jul',
  reviewDays: 7,
  engagementUrl: `${BASE}/engagements/eng-1`,
});

describe('CompletionRequestEmail (BAL-334, VARIANT 1)', () => {
  it('renders the actor, project, counts, dates, window block, and the dual review CTAs', async () => {
    const html = await render(CompletionRequestEmail(completionProps(4)));
    // Celebratory hero + prospective party naming.
    expect(html).toContain('Your project is complete!');
    expect(html).toContain('CloudPeak Consulting');
    // Retrospective actor + the marked-complete date.
    expect(html).toContain('Priya @ CloudPeak');
    expect(html).toContain('4 Jul');
    // Many-path phrasing is pinned: preview, body clause, and delivery-plan value.
    expect(html).toContain('delivered all 4 milestones');
    expect(html).toContain('with all 4 milestones delivered');
    expect(html).toContain('All 4 milestones delivered');
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

  it('zero milestones (retainer seam): project-level framing, never "0 milestones"', async () => {
    const html = await render(CompletionRequestEmail(completionProps(0)));
    // Positive — the count is dropped, warm project-level phrasing throughout.
    expect(html).toContain('marked the project complete'); // preview lead
    expect(html).toContain('wrapped up the work'); // hero subtext lead
    expect(html).toContain('No milestones'); // delivery-plan value
    // Negative — none of the "all 0 / 0 milestones" bugs survive, and the body
    // clause is omitted (no dangling "milestones delivered").
    expect(html).not.toContain('all 0');
    expect(html).not.toContain('All 0');
    expect(html).not.toContain('0 milestones');
    expect(html).not.toContain('milestones delivered');
    expect(html).not.toContain('milestone delivered');
    expect(html).not.toContain('every milestone'); // subtext no longer over-claims
  });

  it('one milestone: singular everywhere, never "1 milestones" or "All 1 milestone"', async () => {
    const html = await render(CompletionRequestEmail(completionProps(1)));
    expect(html).toContain('delivered the milestone'); // preview lead
    expect(html).toContain('with the milestone delivered'); // body clause (contiguous node)
    expect(html).toContain('1 milestone delivered'); // delivery-plan value
    // Negative — no plural-with-1 and no "all 1".
    expect(html).not.toContain('1 milestones');
    expect(html).not.toContain('all 1 milestone');
    expect(html).not.toContain('All 1 milestone');
  });
});

describe('milestonePhrases (zero-milestone / singular correctness)', () => {
  it('zero → no count, warm project-level framing (incl. BAL-338 clauses)', () => {
    expect(milestonePhrases(0)).toEqual({
      previewLead: 'marked the project complete',
      subtextLead: 'wrapped up the work',
      bodyClause: '',
      planValue: 'No milestones',
      doneClause: '',
      deliveredAlongClause: '',
    });
  });

  it('one → singular, never "1 milestones"', () => {
    const p = milestonePhrases(1);
    expect(p.previewLead).toBe('delivered the milestone');
    expect(p.bodyClause).toBe('the milestone delivered');
    expect(p.planValue).toBe('1 milestone delivered');
    expect(p.doneClause).toBe('The milestone is done');
    expect(p.deliveredAlongClause).toBe('the milestone was delivered along the way');
    expect(JSON.stringify(p)).not.toContain('1 milestones');
    expect(JSON.stringify(p)).not.toContain('All 1 milestone');
  });

  it('many → plural with the count (incl. BAL-338 clauses)', () => {
    const p = milestonePhrases(3);
    expect(p.previewLead).toBe('delivered all 3 milestones');
    expect(p.bodyClause).toBe('all 3 milestones delivered');
    expect(p.planValue).toBe('All 3 milestones delivered');
    expect(p.doneClause).toBe('All 3 milestones are done');
    expect(p.deliveredAlongClause).toBe('all 3 milestones were delivered along the way');
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
