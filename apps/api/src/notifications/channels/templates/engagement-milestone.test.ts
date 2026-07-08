import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { EngagementMilestoneCompletedClientEmail } from './engagement-milestone-completed.js';
import { EngagementScopeChangedClientEmail } from './engagement-scope-changed.js';
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

describe('EngagementScopeChangedClientEmail (BAL-333)', () => {
  it('renders the actor, exact body copy (summary + price-unchanged), project context, and workspace CTA', async () => {
    const html = await render(
      EngagementScopeChangedClientEmail({
        firstName: 'Dana',
        actorExpertLabel: 'Priya @ CloudPeak',
        // Quote-free summary so the full sentence is assertable without HTML-entity escaping.
        changeSummary: 'added a data-migration milestone',
        projectTitle: 'CPQ implementation',
        engagementId: 'eng-1',
        baseUrl: BASE,
      })
    );
    // Hero pill + heading.
    expect(html).toContain('Delivery plan updated');
    expect(html).toContain('The delivery plan changed.');
    // Project context (hero subtext).
    expect(html).toContain('CPQ implementation');
    // Exact ticket body copy — the change summary + the price-unchanged reassurance.
    expect(html).toContain(
      'Priya @ CloudPeak updated the delivery plan: added a data-migration milestone. The project price is unchanged.'
    );
    // Deep-links to the delivery workspace (NOT /projects/*).
    expect(html).toContain('/engagements/eng-1');
    expect(html).not.toContain('/projects/');
    expect(html).toContain('View the delivery plan');
  });
});

describe('getEmailTemplate — engagement-scope-changed-client', () => {
  it('builds the exact ticket subject naming the project title', () => {
    const result = getEmailTemplate('engagement-scope-changed-client', {
      recipientName: 'Dana',
      actorExpertLabel: 'Priya @ CloudPeak',
      changeSummary: "added 'Data migration dry-run'",
      projectTitle: 'CPQ implementation',
      engagementId: 'eng-1',
    });
    expect(result.subject).toBe('The delivery plan for CPQ implementation was updated');
    expect(result.component).toBeDefined();
  });
});

describe('getInAppTemplate — BAL-333 scope-changed factories', () => {
  it('scope-changed-client → exact ticket copy, links to the workspace', () => {
    const out = getInAppTemplate('engagement-scope-changed-client', {
      actorExpertLabel: 'Priya',
      changeSummary: "added 'Data migration dry-run'",
      engagementId: 'eng-1',
    });
    expect(out.title).toBe('Delivery plan updated');
    expect(out.body).toBe("Priya updated the delivery plan: added 'Data migration dry-run'.");
    expect(out.actionUrl).toBe('/engagements/eng-1');
  });

  it('scope-changed-admin → project-scoped body with the same summary format', () => {
    const out = getInAppTemplate('engagement-scope-changed-admin', {
      projectTitle: 'CPQ implementation',
      actorExpertLabel: 'Priya',
      changeSummary: "removed 'Legacy import'",
      engagementId: 'eng-1',
    });
    expect(out.title).toBe('Delivery plan updated');
    expect(out.body).toBe("CPQ implementation: Priya removed 'Legacy import'.");
    expect(out.actionUrl).toBe('/engagements/eng-1');
  });

  it('falls back gracefully when actor / summary / project are absent', () => {
    const client = getInAppTemplate('engagement-scope-changed-client', { engagementId: 'eng-1' });
    expect(client.body).toBe('Your expert updated the delivery plan: updated the delivery plan.');
    const admin = getInAppTemplate('engagement-scope-changed-admin', {});
    expect(admin.body).toBe('A project: The expert updated the delivery plan.');
    expect(admin.actionUrl).toBeUndefined();
  });
});
