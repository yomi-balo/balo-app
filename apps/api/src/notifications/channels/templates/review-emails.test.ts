import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { render } from '@react-email/render';
import { getEmailTemplate } from './index.js';

/**
 * BAL-390 — the review-email family: the shared star-rating ask (`ReviewAskBlock`) and
 * its four carriers. These tests are the regression guard for the design's five
 * non-negotiable email constraints AND for the security property that the star link
 * only ever PREFILLS.
 */

// Asserted RELATIVE to the app origin: `BASE_URL` in ./index.ts is env-derived, and a
// test that read the same env would be coupled to the shell it runs in.
const TOKEN = 'rEv1EwT0k3nAbcdefghijklmnopqrstuvwxyz012345';
const STAR = '★'; // ★
const HOLLOW_STAR = '☆'; // ☆ — must NEVER appear (tofu risk); see review-ask-block.tsx

const nudgeData = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  recipientName: 'Dana',
  cadenceStep: 1,
  engagementKind: 'case',
  engagementTitle: 'Flow interview stuck on a loop',
  expertPartyLabel: 'CloudPeak Consulting',
  clientCompanyName: 'Northwind Industrial',
  anchorDate: '4 Jul',
  reviewToken: TOKEN,
  engagementId: 'eng-1',
  ...over,
});

const caseClosedData = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  recipientName: 'Dana',
  clientCompanyName: 'Northwind Industrial',
  expertPartyLabel: 'CloudPeak Consulting',
  caseTitle: 'Flow interview stuck on a loop',
  closedDate: '3 Aug',
  closeReason: 'resolved',
  reviewToken: TOKEN,
  engagementId: 'eng-1',
  ...over,
});

const acceptedClientData = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  recipientName: 'Dana',
  clientCompanyName: 'Northwind Industrial',
  expertPartyLabel: 'CloudPeak Consulting',
  projectTitle: 'CPQ implementation',
  milestonesTotal: 4,
  acceptedOn: '11 Jul 2026',
  reviewToken: TOKEN,
  engagementId: 'eng-1',
  ...over,
});

const autoAcceptedData = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  recipientName: 'Dana',
  clientCompanyName: 'Northwind Industrial',
  expertPartyLabel: 'CloudPeak Consulting',
  projectTitle: 'CPQ implementation',
  milestonesTotal: 4,
  requestedDate: '4 Jul',
  autoDate: '11 Jul',
  reviewDays: 7,
  engagementId: 'eng-1',
  ...over,
});

async function renderTemplate(name: string, data: Record<string, unknown>): Promise<string> {
  return render(getEmailTemplate(name, data).component);
}

/**
 * React SSR splits adjacent text nodes with `<!-- -->` markers and escapes apostrophes
 * to `&#x27;`, so a copy assertion has to read the email the way a human does. Hazard
 * and token assertions deliberately stay on the RAW html.
 */
function readable(html: string): string {
  return html.replaceAll('<!-- -->', '').replaceAll('&#x27;', "'").replaceAll('&amp;', '&');
}

/** Render a template and normalise it for copy assertions. */
async function renderCopy(name: string, data: Record<string, unknown>): Promise<string> {
  return readable(await renderTemplate(name, data));
}

/** Every carrier of the star block, rendered with a token present. */
const CARRIERS_WITH_TOKEN: [string, Record<string, unknown>][] = [
  ['review-nudge', nudgeData()],
  ['engagement-case-closed-client', caseClosedData()],
  ['engagement-accepted-client', acceptedClientData()],
  ['engagement-auto-accepted-client', autoAcceptedData({ reviewToken: TOKEN })],
];

/** The same carriers with the token removed — the "already rated" branch. */
const CARRIERS_WITHOUT_TOKEN: [string, Record<string, unknown>][] = [
  ['engagement-case-closed-client', caseClosedData({ reviewToken: undefined })],
  ['engagement-accepted-client', acceptedClientData({ reviewToken: undefined })],
  ['engagement-auto-accepted-client', autoAcceptedData()],
];

describe('ReviewAskBlock — the five constraints that ARE the design', () => {
  it.each(CARRIERS_WITH_TOKEN)(
    '%s: five prefill stars plus a no-star escape',
    async (name, data) => {
      const html = await renderTemplate(name, data);
      for (const value of [1, 2, 3, 4, 5]) {
        expect(html).toContain(`/review/${TOKEN}?r=${value}"`);
      }
      // The always-present no-`r` path: glyph failure, image blocking, screen readers,
      // and anyone who would rather look at the page before scoring.
      expect(html).toContain(`/review/${TOKEN}"`);
      expect(html).toContain('Rather open your review first?');
    }
  );

  it.each(CARRIERS_WITH_TOKEN)(
    '%s: the no-star escape never promises a writable field the landing gates',
    async (name, data) => {
      // The landing hides its note box until a star is picked ("Pick a star to send your
      // review", BAL-390-DESIGN Artifact 3), so an invitation to write FIRST would be
      // false of every arrival. The escape must describe opening, not writing.
      const html = await renderCopy(name, data);
      expect(html).not.toContain('write a few words first');
      expect(html).not.toContain('few words first');
    }
  );

  /**
   * ⚠ THE FULL-BLEED IS TWO DECLARATIONS, NOT ONE. `Section` emits
   * `<table align="center" width="100%">`, whose `width="100%"` resolves against the
   * card's INNER box no matter what the margins say — so `margin: 0 -40px` ALONE only
   * translates the row 40px left at an unchanged width (measured in headless Chromium:
   * 30.9px targets at 320px, the row 34–40px off-centre against the prompt). It takes
   * `width: calc(100% + 80px)` to buy the padding back and `box-sizing: border-box` to
   * keep the row's own `0 12px` gutter INSIDE that width; with both, the same measurement
   * gives 44.4px @320 / 55.4px @375 / 63.2px @414, centred, with no horizontal overflow.
   * Deleting either half silently returns sub-44px tap targets, so both are pinned here.
   */
  it.each(CARRIERS_WITH_TOKEN)(
    '%s: the star row bleeds by WIDTH, not by margin alone (≥44px at 320px)',
    async (name, data) => {
      const html = await renderTemplate(name, data);
      const starRow = html.slice(0, html.indexOf(`${TOKEN}?r=1`));
      const style = starRow.slice(starRow.lastIndexOf('style="margin:10px -40px 0'));
      expect(style).toContain('width:calc(100% + 80px)');
      expect(style).toContain('box-sizing:border-box');
      expect(style).toContain('padding:0 12px');
    }
  );

  it.each(CARRIERS_WITH_TOKEN)('%s: ★ as text — never ☆, never inline SVG', async (name, data) => {
    const html = await renderTemplate(name, data);
    expect(html).toContain(STAR);
    expect(html).not.toContain(HOLLOW_STAR);
    // Outlook desktop renders through Word and drops inline SVG.
    expect(html).not.toContain('<svg');
  });

  it.each(CARRIERS_WITH_TOKEN)(
    '%s: no :hover, no @media, no class= in the rendered HTML',
    async (name, data) => {
      const html = await renderTemplate(name, data);
      // Gmail and Outlook desktop strip :hover — the five targets are drawn statically.
      expect(html).not.toContain(':hover');
      expect(html).not.toContain('@media');
      expect(html).not.toContain('class=');
    }
  );

  it.each(CARRIERS_WITH_TOKEN)('%s: the token appears ONLY inside href', async (name, data) => {
    const html = await renderTemplate(name, data);
    const withoutHrefs = html.replaceAll(/href="[^"]*"/g, 'href=""');
    expect(withoutHrefs).not.toContain(TOKEN);
  });

  it('states the prefill contract verbatim — the link never writes', async () => {
    const html = await renderCopy('review-nudge', nudgeData());
    expect(html).toContain(
      'Tapping a star opens your review with that score already filled in — you can change it there, and nothing is saved until you send it.'
    );
  });

  it('numbers every star so a mis-tap is legible before the page loads', async () => {
    const html = await renderTemplate('review-nudge', nudgeData());
    const starRow = html.slice(html.indexOf(`${TOKEN}?r=1`), html.indexOf(`${TOKEN}?r=5`) + 400);
    for (const value of [1, 2, 3, 4, 5]) {
      expect(starRow).toContain(`>${value}</p>`);
    }
  });
});

describe('the already-rated branch — the block is GONE, not greyed', () => {
  it.each(CARRIERS_WITHOUT_TOKEN)('%s: zero /review/ anywhere', async (name, data) => {
    const html = await renderTemplate(name, data);
    expect(html).not.toContain('/review/');
    expect(html).not.toContain(STAR);
  });

  it('case close swaps the block for a short thank-you', async () => {
    const html = await renderCopy(
      'engagement-case-closed-client',
      caseClosedData({ reviewToken: undefined })
    );
    expect(html).toContain('Thanks for rating this one already');
  });

  it('the explicit-accept email swaps the block for a short thank-you', async () => {
    const html = await renderCopy(
      'engagement-accepted-client',
      acceptedClientData({ reviewToken: undefined, alreadyRated: true })
    );
    expect(html).toContain('Thanks for rating this one already');
  });

  /**
   * `accept-project.ts` publishes without a token when the MINT FAILS too — a rating
   * token must never break an accept — so "no token" cannot be read as "already rated".
   * The publisher states which happened; absent the statement, the email says nothing.
   */
  it('a FAILED token mint thanks nobody — the slot is simply empty', async () => {
    for (const over of [{ alreadyRated: false }, {}]) {
      const html = await renderCopy(
        'engagement-accepted-client',
        acceptedClientData({ reviewToken: undefined, ...over })
      );
      expect(html).not.toContain('Thanks for rating this one already');
      // Still a complete acceptance record — only the rating line is withheld.
      expect(html).toContain('You accepted the work');
      expect(html).toContain('View the project');
    }
  });

  it('the auto path never thanks, even if a stray alreadyRated rides the payload', async () => {
    const html = await renderCopy(
      'engagement-auto-accepted-client',
      autoAcceptedData({ alreadyRated: true })
    );
    expect(html).not.toContain('Thanks for rating this one already');
  });

  it('the auto-accept email renders exactly as it did before BAL-390', async () => {
    const html = await renderCopy('engagement-auto-accepted-client', autoAcceptedData());
    // No stand-in line at all on this path — nobody acted, so there is nothing to thank.
    expect(html).not.toContain('Thanks for rating this one already');
    expect(html).toContain('closed the project out as delivered');
    expect(html).toContain('All 4 milestones were delivered along the way');
  });
});

describe('review-nudge — two cadence steps and no third', () => {
  it('step 1 is a light touch that promises exactly one more ask', async () => {
    const out = getEmailTemplate('review-nudge', nudgeData({ cadenceStep: 1 }));
    const html = readable(await render(out.component));
    expect(out.subject).toBe('How did it go with CloudPeak Consulting?');
    expect(html).toContain('How did it go?');
    expect(html).toContain("We'll ask once more and then leave it there.");
    // Step 1 reminds; it does not reground.
    expect(html).not.toContain('This one goes back a bit');
  });

  it('step 2 LEADS with the regrounding and closes the door', async () => {
    const out = getEmailTemplate('review-nudge', nudgeData({ cadenceStep: 2 }));
    const html = readable(await render(out.component));
    expect(out.subject).toBe('One last look back at Flow interview stuck on a loop');
    expect(html).toContain('This one goes back a bit, so here');
    expect(html).toContain('we closed the case out on 4 Jul');
    expect(html).toContain(
      "That's the last time we'll ask about this one — no more reminders either way."
    );
    // The regrounding must arrive BEFORE anything is asked of the reader.
    expect(html.indexOf('This one goes back a bit')).toBeLessThan(html.indexOf(`${TOKEN}?r=1`));
  });

  it('the two steps produce different bodies', async () => {
    const one = await renderTemplate('review-nudge', nudgeData({ cadenceStep: 1 }));
    const two = await renderTemplate('review-nudge', nudgeData({ cadenceStep: 2 }));
    expect(one).not.toBe(two);
  });

  it('an out-of-range cadence step degrades to step 1 rather than throwing', async () => {
    const html = await renderCopy('review-nudge', nudgeData({ cadenceStep: 7 }));
    expect(html).toContain("We'll ask once more and then leave it there.");
  });

  it('reads naturally with no consultation count (there is no producer yet)', async () => {
    const html = await renderCopy('review-nudge', nudgeData({ cadenceStep: 2 }));
    expect(html).not.toContain('consultations');
    expect(html).not.toContain('undefined');
  });

  it('folds a consultation count in when one is supplied', async () => {
    const html = await renderCopy(
      'review-nudge',
      nudgeData({ cadenceStep: 2, consultationCount: 3 })
    );
    expect(html).toContain('across 3 consultations');
  });

  /**
   * `close_reason` is a real two-value enum, and step 2's regrounding states WHY the case
   * closed. A `resolved` case was closed by the CLIENT on purpose — telling them things
   * "went quiet" is an assertion about an action they took themselves, seven days after
   * the close email said "That's {case} wrapped up." Mirrors `CaseClosedEmail`.
   */
  describe('step 2 states the real close reason, never a guessed one', () => {
    it('an auto_inactive close reads as Balo tidying up', async () => {
      const html = await renderCopy(
        'review-nudge',
        nudgeData({ cadenceStep: 2, closeReason: 'auto_inactive' })
      );
      expect(html).toContain(
        'Things went quiet after that, so we closed the case out on 4 Jul rather than leave it hanging.'
      );
    });

    it('a resolved close is NEVER described as having gone quiet', async () => {
      const html = await renderCopy(
        'review-nudge',
        nudgeData({ cadenceStep: 2, closeReason: 'resolved' })
      );
      expect(html).not.toContain('went quiet');
      expect(html).not.toContain('rather than leave it hanging');
      expect(html).toContain('and we closed the case out on 4 Jul.');
    });

    it('an absent or unrecognised reason falls back to the neutral wording', async () => {
      for (const over of [{}, { closeReason: 'something_else' }]) {
        const html = await renderCopy('review-nudge', nudgeData({ cadenceStep: 2, ...over }));
        expect(html).not.toContain('went quiet');
        expect(html).toContain('and we closed the case out on 4 Jul.');
      }
    });

    it('a PROJECT nudge never picks up a close reason', async () => {
      const html = await renderCopy(
        'review-nudge',
        nudgeData({ cadenceStep: 2, engagementKind: 'project', closeReason: 'auto_inactive' })
      );
      expect(html).not.toContain('went quiet');
      expect(html).toContain('it was accepted on 4 Jul');
    });
  });

  it('names the party, and the prompt matches the engagement kind', async () => {
    const caseHtml = await renderCopy('review-nudge', nudgeData());
    expect(caseHtml).toContain('How was your consultation with CloudPeak Consulting?');
    const projectHtml = await renderCopy('review-nudge', nudgeData({ engagementKind: 'project' }));
    expect(projectHtml).toContain('How was working with CloudPeak Consulting?');
  });

  it('runs a user-authored title through sanitizeSubjectTitle', () => {
    const out = getEmailTemplate(
      'review-nudge',
      nudgeData({ cadenceStep: 2, engagementTitle: 'CPQ\u0000\nimplementation' })
    );
    expect(out.subject).toBe('One last look back at CPQ  implementation');
    expect(out.subject).not.toContain('\n');
    expect(out.subject).not.toContain('\u0000');
  });
});

describe('engagement-case-closed-client — the fused close email (INERT)', () => {
  it('a resolved close reads as wrapped up', async () => {
    const out = getEmailTemplate('engagement-case-closed-client', caseClosedData());
    const html = readable(await render(out.component));
    expect(out.subject).toBe('Flow interview stuck on a loop is wrapped up');
    expect(html).toContain('wrapped up');
    expect(html).toContain('we closed the case out on 3 Aug');
    expect(html).toContain('View the case');
  });

  it('a quiet-case close reads as tidying up, never as a reprimand', async () => {
    const out = getEmailTemplate(
      'engagement-case-closed-client',
      caseClosedData({ closeReason: 'auto_inactive' })
    );
    const html = readable(await render(out.component));
    expect(out.subject).toBe("We've closed Flow interview stuck on a loop");
    expect(html).toContain('rather than leave it hanging');
  });

  it('puts the record before the ask', async () => {
    const html = await renderCopy('engagement-case-closed-client', caseClosedData());
    expect(html.indexOf('What happens now')).toBeGreaterThan(-1);
    expect(html.indexOf('What happens now')).toBeLessThan(html.indexOf(`${TOKEN}?r=1`));
  });
});

describe('engagement-accepted-client — the actor gets their own record', () => {
  it('confirms the acceptance first, then asks', async () => {
    const out = getEmailTemplate('engagement-accepted-client', acceptedClientData());
    const html = readable(await render(out.component));
    expect(out.subject).toBe('CPQ implementation is complete 🎉');
    expect(html).toContain('You accepted the work');
    expect(html).toContain('This email is your record of that');
    expect(html.indexOf('Congratulations')).toBeLessThan(html.indexOf('What happens now'));
    expect(html.indexOf('What happens now')).toBeLessThan(html.indexOf(`${TOKEN}?r=1`));
  });

  it('reads naturally at zero milestones (the retainer seam)', async () => {
    const html = await renderCopy(
      'engagement-accepted-client',
      acceptedClientData({ milestonesTotal: 0 })
    );
    expect(html).not.toContain('0 milestones');
  });

  it('falls back to a generic hero for a long title', async () => {
    const html = await renderCopy(
      'engagement-accepted-client',
      acceptedClientData({
        projectTitle: 'CPQ implementation to replace the legacy quoting tool across all regions',
      })
    );
    expect(html).toContain('Your project is complete');
  });
});

describe('the notifications tree stays free of the four email hazards', () => {
  // Resolved from this file, never from process.cwd() — CI may run vitest from the
  // repo root or from apps/api and both must find the same tree.
  const NOTIFICATIONS_DIR = fileURLToPath(new URL('../../', import.meta.url));

  /**
   * Drop comments so a docblock that NAMES a hazard (this ticket's
   * `review-ask-block.tsx` explains all four at length) does not read as one. Written
   * as a line walk rather than a regex — no backtracking, nothing for Sonar's ReDoS
   * rule to flag.
   */
  function codeOnly(source: string): string {
    const kept: string[] = [];
    let inBlockComment = false;
    for (const line of source.split('\n')) {
      const trimmed = line.trim();
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        continue;
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true;
        continue;
      }
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      kept.push(line);
    }
    return kept.join('\n');
  }

  const sourceFiles = readdirSync(NOTIFICATIONS_DIR, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') || entry.endsWith('.tsx'))
    .filter((entry) => !entry.includes('.test.'));

  it('finds the notification sources it is meant to scan', () => {
    expect(sourceFiles.length).toBeGreaterThan(50);
  });

  it.each([':hover', '@media', 'className', '<table'])('no source file contains %s', (hazard) => {
    const offenders = sourceFiles.filter((entry) =>
      codeOnly(readFileSync(join(NOTIFICATIONS_DIR, entry), 'utf8')).includes(hazard)
    );
    expect(offenders).toEqual([]);
  });
});
