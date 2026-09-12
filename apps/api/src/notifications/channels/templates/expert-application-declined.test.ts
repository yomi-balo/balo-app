import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@react-email/render';
import { EXPERT_DECLINE_REASONS } from '@balo/shared/experts';
import {
  ExpertApplicationDeclinedEmail,
  EXPERT_APPLICATION_DECLINED_COPY,
  declinedLeadParagraph,
} from './expert-application-declined.js';
import { EXPERT_DECLINE_REASON_LABEL } from './expert-decline-reason-label.js';

/**
 * BAL-549 WEB-REVIEW FIX ROUND (W1) — THE DECLINE STORY MUST NOT PROMISE A RE-APPLICATION.
 *
 * `expertsRepository.submitApplication`'s WHERE is `applicationStatus = 'draft'`, so a `rejected`
 * profile matches no row: re-applying does not work, and BAL-549's "Out of scope" excluded the
 * transition deliberately. Three shipped surfaces promised it anyway. This suite covers the two
 * applicant-facing ones — the EMAIL and the HELP DOC. (The code comments and the misleading
 * submit error are pinned in `apps/web`: `submit-application.test.ts`, `save-draft.test.ts`.)
 *
 * ⚠⚠ FULL LITERALS, NOT `toContain` ON A FRAGMENT. A fragment assertion cannot notice a promise
 * being ADDED, which is the regression that matters here, and it is the failure mode the
 * `feedback_monitor_strings_need_verbatim_pin` rule exists to stop. Every body string of the
 * email is an exported constant and is asserted against its whole text, so a copy change is a
 * deliberate two-file edit. The banned-phrase sweep below is the second layer: it reads the
 * RENDERED HTML and the SHIPPED MARKDOWN, so it also catches a promise re-introduced in prose
 * that no constant covers.
 */

const BASE_URL = 'https://app.balo.expert';

/**
 * The phrases that describe a flow which does not exist. Lower-cased before matching so a
 * sentence-case or title-case spelling cannot slip past.
 */
const BANNED_PROMISES = [
  'apply again',
  're-apply',
  'reapply',
  'apply once more',
  'start from scratch',
  'pick up right where you left off',
  'nothing here is permanent',
] as const;

function assertNoPromise(haystack: string, label: string): void {
  const lowered = haystack.toLowerCase();
  for (const phrase of BANNED_PROMISES) {
    expect(lowered, `${label} must not promise "${phrase}"`).not.toContain(phrase);
  }
}

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

  it('promises nothing that does not exist', () => {
    for (const [key, value] of Object.entries(EXPERT_APPLICATION_DECLINED_COPY)) {
      assertNoPromise(value, `EXPERT_APPLICATION_DECLINED_COPY.${key}`);
    }
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

describe('ExpertApplicationDeclinedEmail', () => {
  it.each(EXPERT_DECLINE_REASONS)(
    'renders the %s reason with no re-application promise and no CTA to the wizard',
    async (reason) => {
      const html = await render(
        ExpertApplicationDeclinedEmail({ firstName: 'Priya', reason, baseUrl: BASE_URL })
      );

      /*
        Guards the guard: the sweep below is only meaningful if the email really rendered.

        ⚠ FRAGMENTS, AND APOSTROPHE-FREE ONES, DELIBERATELY. React escapes `'` to `&#x27;` in
        text and inserts `<!-- -->` around every interpolation, so a whole-sentence `toContain`
        against the HTML would fail for reasons that have nothing to do with the copy. The WHOLE
        sentences are pinned above, against the exported constants; these fragments only prove
        this render is the real email.
      */
      expect(html).toContain('Application update');
      expect(html).toContain('the end of the road');
      expect(html).toContain('a person on our team reads every reply');
      expect(html).toContain('Nothing further is needed from you');
      // The reason CATEGORY renders — the one dynamic sentence in the body.
      expect(html).toContain(EXPERT_DECLINE_REASON_LABEL[reason]);

      assertNoPromise(html, 'the decline email');

      /*
        ⚠ NO LINK TO THE WIZARD. `/expert/apply` was the actionable half of the false promise:
        the page renders for a declined applicant and then both writes refuse. The support
        channel in `SupportFooter` is the one action this email offers.
      */
      expect(html).not.toContain(`${BASE_URL}/expert/apply`);
      expect(html).toContain('support@getbalo.com');
      expect(html).toContain(EXPERT_APPLICATION_DECLINED_COPY.supportPrefix);

      // The staff-only note has no field on this template's props — nothing to leak.
      expect(html).not.toContain('undefined');
    }
  );

  it('still greets a missing first name gracefully', async () => {
    const html = await render(
      ExpertApplicationDeclinedEmail({ firstName: 'there', reason: 'not_a_fit', baseUrl: BASE_URL })
    );
    // The preview text is built in JS, so it survives rendering as one contiguous string.
    expect(html).toContain('An update on your Balo expert application, there.');
  });
});

/**
 * THE HELP DOC IS A SHIPPED SURFACE TOO. `docs/help/what-happens-after-you-apply.md` told the
 * same story ("you're welcome to apply again … your application is saved, so you won't start from
 * scratch") and the submission email promises its content in production. It is plain Markdown
 * with no module to import, so the file itself is read.
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

  it('promises no re-application', () => {
    assertNoPromise(readHelpDoc(), 'the help doc');
  });

  it('says plainly that re-submitting is not available today', () => {
    expect(readHelpDoc()).toContain(
      "Submitting the same application again isn't something you can do from your account today."
    );
  });
});
