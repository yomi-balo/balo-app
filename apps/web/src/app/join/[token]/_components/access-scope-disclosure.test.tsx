import { describe, it, expect } from 'vitest';
import { render } from '@/test/utils';
import { axe } from 'jest-axe';

import { AccessScopeDisclosure } from './access-scope-disclosure';

/**
 * Copy block by block, joined with a separator — never bare `textContent` (word-run trap).
 * Reads the heading AND the body, so a copy assertion cannot be dodged by moving a phrase
 * from one to the other.
 */
function copyBlocks(container: HTMLElement): string {
  return Array.from(container.querySelectorAll('h2, p'))
    .map((node) => node.textContent ?? '')
    .join(' | ');
}

describe('AccessScopeDisclosure', () => {
  describe("engagement scope — the retrospective grant's disclosure", () => {
    /**
     * ⚠⚠ THE SENTENCE THIS COMPONENT EXISTS FOR, and the one a copy pass must not
     * casually reword. It is the second-person mirror of the composer's third-person
     * line at `.claude/design-references/guest-invitation.jsx:289`. TWO clauses are
     * load-bearing because they are the two things a reader would otherwise be
     * surprised by later:
     *   · the artefact list — "recaps, transcripts and action items"
     *   · the retrospective clause — "including ones held before you were invited"
     * `guestMayReadMeeting` has NO date comparison anywhere, so the second clause is
     * the ONLY place the retrospective reach of the grant is ever stated to the person
     * it is about.
     */
    it('states the artefacts AND the retrospective reach, in the second person', () => {
      const { container } = render(<AccessScopeDisclosure accessScope="engagement" />);
      const text = copyBlocks(container);

      // ⚠ ENGAGEMENT-TYPE-AGNOSTIC, and this is a correction. `resolveGuestAccessScope`
      // grants `engagement` on `project_kickoff`, `package_session` and `retainer_checkin`
      // as readily as on `case`, so "every consultation in this case" was false for three
      // of the four — and contradicted the invite email, which describes the SAME grant
      // agnostically. Two disclosures of one grant must not disagree.
      expect(text).toMatch(/every call in this piece of work/i);
      expect(text).not.toMatch(/in this case/i);
      expect(text).toMatch(/recaps, transcripts and action items/i);
      expect(text).toMatch(/including ones held before you were invited/i);
      // Second person, not the composer's third person about a named guest.
      expect(text).toMatch(/you'll be able to read/i);
      expect(text).not.toMatch(/they were invited/i);
    });

    it('names no organisation and no person', () => {
      const { container } = render(<AccessScopeDisclosure accessScope="engagement" />);
      const text = copyBlocks(container);

      // The inviter's company is stated ONCE, in the attribution line above this block.
      expect(text).not.toMatch(/@/);
      expect(text).not.toMatch(/\bcompany\b/i);
    });
  });

  describe('meeting scope — the narrow grant', () => {
    it('promises only this call and its recap', () => {
      const { container } = render(<AccessScopeDisclosure accessScope="meeting" />);
      const text = copyBlocks(container);

      expect(text).toMatch(/only see this call and its recap/i);
    });

    /**
     * ⚠ The narrow branch must not mention the wide grant at all. A reader on
     * `meeting` scope who sees the words "every consultation in this case" — even in a
     * negation — has been told something false about their own access.
     */
    it('never mentions the engagement-wide grant, not even to deny it', () => {
      const { container } = render(<AccessScopeDisclosure accessScope="meeting" />);
      const text = copyBlocks(container);

      expect(text).not.toMatch(/every call in this piece of work/i);
      expect(text).not.toMatch(/before you were invited/i);
    });
  });

  /**
   * ⚠ A REAL `<h2>`, NOT A BOLD `<p>`. This is the one block on the page whose entire job is
   * informed consent, and as a styled paragraph it was invisible to heading navigation — a
   * screen-reader user had no landmark for the disclosure they are being asked to act on.
   * Asserted by ROLE so a future restyle cannot quietly demote it back to a paragraph.
   */
  it('renders the heading as a level-2 heading on both branches', () => {
    for (const scope of ['meeting', 'engagement'] as const) {
      const view = render(<AccessScopeDisclosure accessScope={scope} />);
      expect(
        view.getByRole('heading', { level: 2, name: /what you'll be able to see/i })
      ).toBeInTheDocument();
      view.unmount();
    }
  });

  it('discloses no email address on either branch', () => {
    for (const scope of ['meeting', 'engagement'] as const) {
      const { container, unmount } = render(<AccessScopeDisclosure accessScope={scope} />);
      expect(container.textContent ?? '').not.toMatch(/[a-z0-9]@[a-z0-9]/i);
      unmount();
    }
  });

  /**
   * The two branches must be visually distinguishable — the wide grant is the one the
   * design reference marks with the warning ramp precisely so it is not skimmed past.
   * Asserted on the CSS-variable token class, never on a hex value.
   */
  it('marks the wide grant with the warning ramp and the narrow one without it', () => {
    const wide = render(<AccessScopeDisclosure accessScope="engagement" />);
    expect(wide.container.querySelector('.bg-warning\\/10')).not.toBeNull();
    wide.unmount();

    const narrow = render(<AccessScopeDisclosure accessScope="meeting" />);
    expect(narrow.container.querySelector('.bg-warning\\/10')).toBeNull();
  });

  it('has no axe violations on either branch', async () => {
    const wide = render(<AccessScopeDisclosure accessScope="engagement" />);
    expect(await axe(wide.container)).toHaveNoViolations();
    wide.unmount();

    const narrow = render(<AccessScopeDisclosure accessScope="meeting" />);
    expect(await axe(narrow.container)).toHaveNoViolations();
  });
});
