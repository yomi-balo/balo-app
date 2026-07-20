import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { ActionItemAssignedEmail } from './action-item-assigned.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

const BASE = 'https://app.balo.expert';

const props = (over: Record<string, unknown> = {}) => ({
  firstName: 'Dana',
  projectTitle: 'CPQ implementation',
  actorLabel: 'Priya @ CloudPeak',
  actionItemBody: 'Send the migration plan to the client',
  dueOn: '9 Jul 2026',
  engagementId: 'eng-1',
  baseUrl: BASE,
  ...over,
});

/** Strip the React-Email `<!-- -->` interpolation markers so multi-part text reads naturally. */
function clean(html: string): string {
  return html.replaceAll('<!-- -->', '').replaceAll('&amp;', '&');
}

describe('ActionItemAssignedEmail (BAL-391)', () => {
  it('greets by first name, names the actor, the item, the project, and the due date', async () => {
    const html = clean(await render(ActionItemAssignedEmail(props())));
    expect(html).toContain('Hi Dana,');
    expect(html).toContain('Priya @ CloudPeak');
    expect(html).toContain('Send the migration plan to the client');
    expect(html).toContain('CPQ implementation');
    expect(html).toContain('9 Jul 2026');
    // CTA deep-links to the delivery workspace (not /projects).
    expect(html).toContain('/engagements/eng-1');
  });

  it('omits the due-date line when no due date is set', async () => {
    const html = clean(await render(ActionItemAssignedEmail(props({ dueOn: undefined }))));
    expect(html).not.toContain('noted for');
    expect(html).toContain('Send the migration plan to the client');
  });

  it('falls back to the "there" greeting for a name-less recipient', async () => {
    const html = clean(await render(ActionItemAssignedEmail(props({ firstName: 'there' }))));
    expect(html).toContain('Hi there,');
  });

  it('caps a very long item body with an ellipsis', async () => {
    const longBody = 'x'.repeat(400);
    const html = clean(await render(ActionItemAssignedEmail(props({ actionItemBody: longBody }))));
    expect(html).toContain('…');
    expect(html).not.toContain('x'.repeat(400));
  });

  it('uses no countdown / pressure framing (due date is a helpful fact)', async () => {
    const html = await render(ActionItemAssignedEmail(props()));
    expect(html).not.toMatch(/deadline|overdue|countdown|last chance|hurry|act now/i);
  });

  it('uses no gendered pronouns', async () => {
    const html = await render(ActionItemAssignedEmail(props()));
    expect(html).not.toMatch(/\b(he|him|his|she|her|hers)\b/i);
  });
});

describe('getEmailTemplate — action-item-assigned factory', () => {
  it('greets by recipientName and builds a subject naming the actor + project', async () => {
    const out = getEmailTemplate('action-item-assigned', {
      recipientName: 'Dana',
      actorLabel: 'Priya @ CloudPeak',
      projectTitle: 'CPQ implementation',
      actionItemBody: 'Send the migration plan',
      dueOn: '9 Jul 2026',
      engagementId: 'eng-1',
    });
    expect(out.subject).toBe('Priya @ CloudPeak assigned you an action item on CPQ implementation');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Dana,');
    expect(html).toContain('/engagements/eng-1');
  });

  it('degrades gracefully when optional fields are absent', async () => {
    const out = getEmailTemplate('action-item-assigned', {});
    const html = clean(await render(out.component));
    expect(html).toContain('Hi there,');
    expect(out.subject).toContain('assigned you an action item');
  });

  it('throws on an unknown template name (missing-template guard)', () => {
    expect(() => getEmailTemplate('action-item-does-not-exist', {})).toThrow(
      /Unknown email template/
    );
  });
});

describe('getInAppTemplate — action-item-assigned', () => {
  it('renders a workspace-linked notice naming the actor, the item, and the due date', () => {
    const out = getInAppTemplate('action-item-assigned', {
      actorLabel: 'Priya @ CloudPeak',
      actionItemBody: 'Send the migration plan',
      dueOn: '9 Jul 2026',
      engagementId: 'eng-1',
    });
    expect(out.title).toBe('New action item');
    expect(out.body).toBe(
      "Priya @ CloudPeak assigned you 'Send the migration plan' · noted for 9 Jul 2026."
    );
    expect(out.actionUrl).toBe('/engagements/eng-1');
  });

  it('omits the due suffix when no due date is set, and falls back gracefully', () => {
    const out = getInAppTemplate('action-item-assigned', { engagementId: 'eng-1' });
    expect(out.body).toBe("A teammate assigned you 'an action item'.");
    expect(out.actionUrl).toBe('/engagements/eng-1');
  });
});
