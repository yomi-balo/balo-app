import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { EngagementMilestoneCompletedClientEmail } from './engagement-milestone-completed.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

const BASE = 'https://app.balo.expert';

describe('EngagementMilestoneCompletedClientEmail (BAL-332)', () => {
  it('renders the actor, milestone, verbatim note, progress line, and workspace CTA', async () => {
    const html = await render(
      EngagementMilestoneCompletedClientEmail({
        firstName: 'Dana',
        actorExpertLabel: 'Priya @ CloudPeak',
        milestoneTitle: 'Discovery workshop',
        completedOn: '30 Jun 2026',
        completionNote: 'Shipped the deck and the recording.',
        completedCount: 2,
        totalCount: 3,
        engagementId: 'eng-1',
        baseUrl: BASE,
      })
    );
    expect(html).toContain('Priya @ CloudPeak');
    expect(html).toContain('Discovery workshop');
    expect(html).toContain('30 Jun 2026');
    // Verbatim delivery note (the trust artifact).
    expect(html).toContain('Shipped the deck and the recording.');
    // Progress line renders exactly ONCE (body only — not duplicated as hero subtext).
    expect(html.split('2 of 3 milestones are now complete.').length - 1).toBe(1);
    // Deep-links to the delivery workspace (NOT /projects/*).
    expect(html).toContain('/engagements/eng-1');
    expect(html).not.toContain('/projects/');
  });

  it('omits the delivery-note callout when there is no note', async () => {
    const html = await render(
      EngagementMilestoneCompletedClientEmail({
        firstName: 'Dana',
        actorExpertLabel: 'Priya',
        milestoneTitle: 'Discovery',
        completedOn: '30 Jun 2026',
        completedCount: 1,
        totalCount: 1,
        engagementId: 'eng-1',
        baseUrl: BASE,
      })
    );
    // The delivery-note callout (its 📦 marker + success-tint bg) is absent without a note.
    expect(html).not.toContain('📦');
    expect(html).not.toContain('#ECFDF5');
    // The progress line + workspace CTA still render.
    expect(html).toContain('1 of 1 milestones are now complete.');
    expect(html).toContain('/engagements/eng-1');
  });
});

describe('getEmailTemplate — engagement-milestone-completed-client', () => {
  it('builds the subject naming the expert PARTY + project title', () => {
    const result = getEmailTemplate('engagement-milestone-completed-client', {
      recipientName: 'Dana',
      expertPartyLabel: 'CloudPeak Consulting',
      actorExpertLabel: 'Priya @ CloudPeak',
      projectTitle: 'CPQ implementation',
      milestoneTitle: 'Discovery',
      completedOn: '30 Jun 2026',
      completionNote: 'Shipped.',
      completedCount: 2,
      totalCount: 3,
      engagementId: 'eng-1',
    });
    expect(result.subject).toBe('CloudPeak Consulting completed a milestone on CPQ implementation');
    expect(result.component).toBeDefined();
  });
});

describe('getInAppTemplate — BAL-332 milestone factories', () => {
  it('completed-client → names the actor + "n/m", links to the workspace', () => {
    const out = getInAppTemplate('engagement-milestone-completed-client', {
      actorExpertLabel: 'Priya',
      milestoneTitle: 'Discovery',
      completedCount: 2,
      totalCount: 3,
      engagementId: 'eng-1',
    });
    expect(out.title).toBe('Milestone completed');
    expect(out.body).toBe("Priya completed 'Discovery' (2/3).");
    expect(out.actionUrl).toBe('/engagements/eng-1');
  });

  it('completed-admin → project-scoped body with "n/m"', () => {
    const out = getInAppTemplate('engagement-milestone-completed-admin', {
      projectTitle: 'CPQ implementation',
      milestoneTitle: 'Discovery',
      completedCount: 2,
      totalCount: 3,
      engagementId: 'eng-1',
    });
    expect(out.title).toBe('Milestone completed');
    expect(out.body).toBe("CPQ implementation: 'Discovery' completed (2/3).");
    expect(out.actionUrl).toBe('/engagements/eng-1');
  });

  it('reverted → "reopened" body shared by client + admin', () => {
    const out = getInAppTemplate('engagement-milestone-reverted', {
      actorExpertLabel: 'Priya',
      milestoneTitle: 'Discovery',
      engagementId: 'eng-1',
    });
    expect(out.title).toBe('Milestone reopened');
    expect(out.body).toBe("Priya moved 'Discovery' back to in progress.");
    expect(out.actionUrl).toBe('/engagements/eng-1');
  });

  it('drops the "n/m" suffix when the counts are absent', () => {
    const out = getInAppTemplate('engagement-milestone-completed-client', {
      actorExpertLabel: 'Priya',
      milestoneTitle: 'Discovery',
      engagementId: 'eng-1',
    });
    expect(out.body).toBe("Priya completed 'Discovery'.");
  });
});
