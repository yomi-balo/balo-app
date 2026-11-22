import { describe, expect, it } from 'vitest';
import { render } from '@react-email/render';
import {
  ProjectInvitationReminderEmail,
  invitationClientName,
} from './project-invitation-reminder.js';
import { getEmailTemplate } from './index.js';

const BASE = 'https://app.balo.expert';

function clean(html: string): string {
  return html.replaceAll('<!-- -->', '').replaceAll('&amp;', '&').replaceAll('&#x27;', "'");
}

/** Visible prose only: one linear scan, no regex (S5852). */
function visibleText(html: string): string {
  let out = '';
  let depth = 0;
  for (const character of html) {
    if (character === '<') {
      depth += 1;
    } else if (character === '>' && depth > 0) {
      depth -= 1;
      out += ' ';
    } else if (depth === 0) {
      out += character;
    }
  }
  return out;
}

function words(text: string): string {
  return ` ${visibleText(text)
    .toLowerCase()
    .replaceAll(/[^a-z0-9$]+/g, ' ')} `;
}

function renderEmail(companyName: string): Promise<string> {
  return render(
    ProjectInvitationReminderEmail({
      firstName: 'Dana',
      projectTitle: 'CRM rollout',
      projectRequestId: 'req-1',
      companyName,
      baseUrl: BASE,
    })
  );
}

describe('invitationClientName', () => {
  it.each([
    ['Northwind', 'Northwind'],
    ['  Northwind  ', 'Northwind'],
    ['', 'The client'],
    ['   ', 'The client'],
    [undefined, 'The client'],
  ])('%j reads %j', (input, expected) => {
    expect(invitationClientName(input)).toBe(expected);
  });
});

describe('ProjectInvitationReminderEmail', () => {
  it('names the client, shows the title and links the request', async () => {
    const html = clean(await renderEmail('Northwind'));
    expect(html).toContain('Northwind is waiting on your answer.');
    expect(html).toContain('Waiting on your answer');
    expect(html).toContain('Open the request →');
    expect(html).toContain(`${BASE}/projects/req-1`);
    expect(html).toContain('CRM rollout');
  });

  it('falls back to "The client" for a blank company name', async () => {
    const html = clean(await renderEmail(''));
    expect(html).toContain('The client is waiting on your answer.');
  });

  it('mentions no price, budget, fee or money', async () => {
    const normalised = words(await renderEmail('Northwind'));
    for (const word of [
      'price',
      'pricing',
      'rate',
      'rates',
      'budget',
      'fee',
      'fees',
      'cost',
      'aud',
      'usd',
    ]) {
      expect(normalised).not.toContain(` ${word} `);
    }
    expect(normalised).not.toContain('$');
  });

  it('uses no gendered pronoun', async () => {
    const normalised = words(await renderEmail('Northwind'));
    for (const word of ['he', 'she', 'his', 'her', 'him', 'hers']) {
      expect(normalised).not.toContain(` ${word} `);
    }
  });
});

describe('project-invitation-reminder registry entry', () => {
  it('builds the subject from the sanitised title', () => {
    const built = getEmailTemplate('project-invitation-reminder', {
      recipientName: 'Dana',
      title: 'CRM rollout',
      projectRequestId: 'req-1',
      companyName: 'Northwind',
    });
    expect(built.subject).toBe('A project is waiting on your answer: CRM rollout');
  });

  it('falls back when title and company are missing', () => {
    const built = getEmailTemplate('project-invitation-reminder', { projectRequestId: 'req-1' });
    expect(built.subject).toBe('A project is waiting on your answer: a project');
  });
});
