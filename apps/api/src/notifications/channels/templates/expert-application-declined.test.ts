import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@react-email/render';
import { EXPERT_DECLINE_REASONS } from '@balo/shared/experts';
import {
  ExpertApplicationDeclinedEmail,
  EXPERT_APPLICATION_DECLINED_COPY,
  declinedLeadParagraph,
  REAPPLY_HEADING,
  reapplyText,
  REAPPLY_TEXT_UNDATED,
  REAPPLY_CTA_LABEL,
} from './expert-application-declined.js';
import { EXPERT_DECLINE_REASON_LABEL } from './expert-decline-reason-label.js';

/**
 * BAL-557 — THE DECLINE STORY NOW PROMISES A RE-APPLICATION, DATED AND TRUE.
 *
 * BAL-549's web-review fix round (W1) banned the promise because the transition did not exist.
 * BAL-557 builds it (`expertsRepository.reopenApplication`) behind a server-enforced,
 * runtime-configurable cooldown, so this suite REPLACES the old banned-phrase sweep with
 * verbatim pins of the restored copy: every sentence of the re-application block, the CTA href,
 * and both the dated and undated variants.
 *
 * ⚠⚠ FULL LITERALS, NOT `toContain` ON A FRAGMENT (`feedback_monitor_strings_need_verbatim_pin`).
 */

const BASE_URL = 'https://app.balo.expert';

describe('EXPERT_APPLICATION_DECLINED_COPY', () => {
  it('is the exact shipped copy, sentence for sentence', () => {
    expect(EXPERT_APPLICATION_DECLINED_COPY).toEqual({
      heroSubtext: "We're not able to approve your application this time.",
      calloutHeading: "This isn't the end of the road",
      calloutText:
        'Experience, certifications and the mix of work clients ask us for all move over time. ' +
        'If yours change, we would like to hear about it — a person on our team reads every reply.',
      standing:
        'Nothing further is needed from you, and your Balo account stays exactly as it is — you ' +
        'can keep using Balo to find experts of your own whenever you need one.',
      supportPrefix: 'Want to talk it through?',
    });
  });
});

describe('declinedLeadParagraph', () => {
  it('states the decision and the reason category, in one verbatim sentence', () => {
    expect(declinedLeadParagraph('we could not verify the certifications listed')).toBe(
      "Thanks for taking the time to apply. Our team has reviewed your application, and we're " +
        'not able to approve it this time — we could not verify the certifications listed.'
    );
  });
});

describe('the restored re-application copy', () => {
  it('pins the heading verbatim', () => {
    expect(REAPPLY_HEADING).toBe("You're welcome to try again");
  });

  it('pins the dated text verbatim, with the date spliced in exactly once', () => {
    expect(reapplyText('9 Dec 2026')).toBe(
      "You're welcome to start a new application from 9 Dec 2026. Your earlier answers stay " +
        'saved, so you can pick up and update them rather than start from the beginning.'
    );
  });

  it('pins the undated fallback verbatim — no digit-day count anywhere in it', () => {
    expect(REAPPLY_TEXT_UNDATED).toBe(
      "You're welcome to start a new application once a short wait has passed. Your earlier " +
        'answers stay saved, so you can pick up and update them rather than start from the ' +
        'beginning.'
    );
    expect(REAPPLY_TEXT_UNDATED).not.toMatch(/\d/);
  });

  it('pins the CTA label verbatim', () => {
    expect(REAPPLY_CTA_LABEL).toBe('Start a new application');
  });
});

describe('ExpertApplicationDeclinedEmail', () => {
  it.each(EXPERT_DECLINE_REASONS)(
    'renders the %s reason with the dated re-application block and its CTA',
    async (reason) => {
      const html = await render(
        ExpertApplicationDeclinedEmail({
          firstName: 'Priya',
          reason,
          baseUrl: BASE_URL,
          reapplyAvailableDate: '9 Dec 2026',
        })
      );

      expect(html).toContain('Application update');
      expect(html).toContain('the end of the road');
      expect(html).toContain('a person on our team reads every reply');
      expect(html).toContain('Nothing further is needed from you');
      // The reason CATEGORY renders — the one dynamic sentence in the body.
      expect(html).toContain(EXPERT_DECLINE_REASON_LABEL[reason]);

      // The re-application block renders with the dated copy, not the undated fallback.
      expect(html).toContain('welcome to start a new application from 9 Dec 2026');
      expect(html).not.toContain('once a short wait has passed');

      // The CTA links the REAL route — `DeclinedApplicationPanel` (apps/web), not a dead help
      // doc and not a bare `/expert/apply` with no destination state.
      expect(html).toContain(`${BASE_URL}/expert/apply`);
      expect(html).toContain(REAPPLY_CTA_LABEL);

      expect(html).toContain('support@getbalo.com');
      expect(html).toContain(EXPERT_APPLICATION_DECLINED_COPY.supportPrefix);

      // The staff-only note has no field on this template's props — nothing to leak.
      expect(html).not.toContain('undefined');
    }
  );

  it('falls back to the undated variant for a pre-BAL-557-shaped job', async () => {
    const html = await render(
      ExpertApplicationDeclinedEmail({
        firstName: 'Priya',
        reason: 'not_a_fit',
        baseUrl: BASE_URL,
        reapplyAvailableDate: null,
      })
    );
    expect(html).toContain('welcome to start a new application once a short wait has passed');
    expect(html).toContain(`${BASE_URL}/expert/apply`);
  });

  it('still greets a missing first name gracefully', async () => {
    const html = await render(
      ExpertApplicationDeclinedEmail({
        firstName: 'there',
        reason: 'not_a_fit',
        baseUrl: BASE_URL,
        reapplyAvailableDate: '9 Dec 2026',
      })
    );
    // The preview text is built in JS, so it survives rendering as one contiguous string.
    expect(html).toContain('An update on your Balo expert application, there.');
  });
});

/**
 * THE HELP DOC IS A SHIPPED SURFACE TOO. `docs/help/what-happens-after-you-apply.md` tells the
 * same story the decline email does. It is plain Markdown with no module to import, so the file
 * itself is read.
 *
 * Vitest may run from the package or the repo root (CI does the latter), so the repo root is
 * resolved against both and a miss THROWS rather than passing vacuously (memory
 * `reference_web_server_disk_asset_cwd`).
 */
function readHelpDoc(): string {
  const relative = join('docs', 'help', 'what-happens-after-you-apply.md');
  const candidates = [join(process.cwd(), relative), join(process.cwd(), '..', '..', relative)];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(`Could not locate ${relative} from ${process.cwd()}`);
  }
  return readFileSync(found, 'utf8');
}

describe('docs/help/what-happens-after-you-apply.md', () => {
  it('still documents the decline outcome (guards the guard)', () => {
    const doc = readHelpDoc();
    expect(doc).toContain("## If your application isn't approved");
    expect(doc).toContain('support@getbalo.com');
  });

  it('mentions starting a new application', () => {
    const doc = readHelpDoc().toLowerCase();
    expect(doc).toContain('start a new application');
  });

  // The doc is static Markdown and cannot read the runtime `expert_reapply_cooldown_days`
  // setting, so it must never hard-code the wait in days (a config change would make it lie).
  it('never hard-codes the cooldown as a number of days', () => {
    const doc = readHelpDoc();
    expect(doc).not.toMatch(/\d+[\s-]*day/i);
  });
});
