import { describe, expect, it } from 'vitest';
import { render } from '@react-email/render';
import {
  ProjectProposalReviewReminderEmail,
  proposalsReadyPhrase,
} from './project-proposal-review-reminder.js';
import { getEmailTemplate } from './index.js';

const BASE = 'https://app.balo.expert';

/** Strip the React-Email `<!-- -->` interpolation markers so multi-part text reads naturally. */
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

function renderEmail(awaitingCount: number): Promise<string> {
  return render(
    ProjectProposalReviewReminderEmail({
      firstName: 'Dana',
      projectTitle: 'CRM rollout',
      projectRequestId: 'req-1',
      awaitingCount,
      baseUrl: BASE,
    })
  );
}

describe('proposalsReadyPhrase', () => {
  it.each([
    [0, '1 proposal is ready'],
    [1, '1 proposal is ready'],
    [2, '2 proposals are ready'],
    [3, '3 proposals are ready'],
  ])('count %s reads %s', (count, expected) => {
    expect(proposalsReadyPhrase(count)).toBe(expected);
  });
});

describe('ProjectProposalReviewReminderEmail', () => {
  it('renders the singular copy and the request CTA for one proposal', async () => {
    const html = clean(await renderEmail(1));
    expect(html).toContain('1 proposal is ready for your review');
    expect(html).toContain('Review the proposal →');
    expect(html).not.toContain('Review proposals →');
    expect(html).toContain('A proposal is waiting');
    expect(html).toContain('Questions about this proposal?');
    expect(html).toContain(`${BASE}/projects/req-1`);
    expect(html).toContain('CRM rollout');
  });

  it('renders the plural copy for three proposals', async () => {
    const html = clean(await renderEmail(3));
    expect(html).toContain('3 proposals are ready for your review');
    expect(html).not.toContain('1 proposal is ready');
    expect(html).toContain('Review proposals →');
    expect(html).toContain('Proposals waiting');
    expect(html).toContain('Questions about these proposals?');
  });

  it.each([1, 3])('mentions no price, budget, fee or money for %s proposals', async (count) => {
    const normalised = words(await renderEmail(count));
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
    const normalised = words(await renderEmail(3));
    for (const word of ['he', 'she', 'his', 'her', 'him', 'hers']) {
      expect(normalised).not.toContain(` ${word} `);
    }
  });
});

describe('project-proposal-review-reminder registry entry', () => {
  it('builds a count-aware subject and passes the payload through', () => {
    const built = getEmailTemplate('project-proposal-review-reminder', {
      recipientName: 'Dana',
      title: 'CRM rollout',
      projectRequestId: 'req-1',
      awaitingCount: 3,
    });
    expect(built.subject).toBe('3 proposals are ready for review: CRM rollout');
  });

  it('defaults to the singular subject when the count is missing', () => {
    const built = getEmailTemplate('project-proposal-review-reminder', {
      title: 'CRM rollout',
      projectRequestId: 'req-1',
    });
    expect(built.subject).toBe('1 proposal is ready for review: CRM rollout');
  });
});
