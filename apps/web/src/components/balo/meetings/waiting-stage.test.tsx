import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import {
  CLIENT_WAITING_BODY,
  NEUTRAL_WAITING_COPY,
  UNKNOWN_WAITING_FACTS,
  waitingCopyFor,
  type WaitingAbsentParty,
  type WaitingFacts,
  type WaitingPhase,
} from '@/lib/meetings/waiting-copy';
import { WaitingStage } from './waiting-stage';

/**
 * BAL-435 — the stage's EMPTY state, across both progressions and all four phases.
 *
 * ⚠⚠ THE EXPECTED STRINGS ARE **IMPORTED FROM `waiting-copy.ts`**, never re-typed here. A test
 * that hard-codes the prose passes happily against copy that drifted in one of the two places —
 * which is the whole reason the copy is data rather than twelve JSX literals.
 *
 * ⚠ ONLY `pre-start` IS REACHABLE IN PRODUCTION TODAY (`meeting_presence` has no writer). All
 * four are covered here so BAL-134 wires the transitions in with no redesign and, just as
 * importantly, with no uncovered changed lines when it does.
 */

// jsdom has no `matchMedia`, which real `useReducedMotion` reads.
vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

/**
 * BAL-134 — the server-mirror facts. ⚠ THE `settled` ARM BRANCHES ON `outcome`, so the table
 * below drives each party with the outcome ITS settled sentence is written for; the other arms
 * are covered by equality in `waiting-copy.test.ts`.
 */
const FACTS: WaitingFacts = {
  noShowFloorMinutes: 15,
  outcome: null,
  expertPresenceObserved: true,
};

function factsFor(absentParty: WaitingAbsentParty): WaitingFacts {
  return { ...FACTS, outcome: absentParty === 'client' ? 'no_show_client' : 'missed_call' };
}

const INPUT = {
  counterpartyFirstName: 'Dana',
  scheduledStartLabel: '10:00 am',
  ...FACTS,
} as const;

const PHASES: readonly WaitingPhase[] = ['pre-start', 'running', 'near', 'settled'];
const PARTIES: readonly WaitingAbsentParty[] = ['expert', 'client'];

function renderWaiting(
  absentParty: WaitingAbsentParty,
  phase: WaitingPhase,
  headingRef?: React.Ref<HTMLHeadingElement>,
  facts: WaitingFacts = FACTS
): HTMLElement {
  return render(
    <WaitingStage
      phase={phase}
      facts={facts}
      // ⚠⚠ RULING R10 — ONE NULLABLE SUBJECT, NOT THREE OPTIONAL PROPS. Three separate props are
      // how `"your expert"` and `"the scheduled time"` shipped as placeholder literals beside a
      // hard-coded `absentParty="expert"`.
      subject={{ absentParty, ...INPUT }}
      headingRef={headingRef}
    />
  ).container;
}

/** The GUEST mounts, structurally: no route provider ⇒ no subject ⇒ no party's clock named. */
function renderNeutral(headingRef?: React.Ref<HTMLHeadingElement>): HTMLElement {
  return render(
    <WaitingStage
      phase="pre-start"
      subject={null}
      facts={UNKNOWN_WAITING_FACTS}
      headingRef={headingRef}
    />
  ).container;
}

/** The glyph that sits in the avatar badge — compared by its own markup, not by a class name. */
function glyphMarkupOf(container: HTMLElement): string {
  const glyph = container.querySelector('svg');
  expect(glyph).not.toBeNull();
  return glyph?.innerHTML ?? '';
}

describe('WaitingStage — the 4 × 2 copy table, rendered', () => {
  for (const absentParty of PARTIES) {
    for (const phase of PHASES) {
      it(`renders the ${absentParty}-absent / ${phase} copy from the shared module`, () => {
        const expected = waitingCopyFor(absentParty, phase, { ...INPUT, ...factsFor(absentParty) });
        renderWaiting(absentParty, phase, undefined, factsFor(absentParty));

        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(expected.title);
        expect(screen.getByText(expected.body)).toBeInTheDocument();
      });
    }
  }

  it('⚠ R3 — the client-waiting line is balo-in-meeting-ui.jsx:236, verbatim', () => {
    renderWaiting('expert', 'pre-start');

    expect(screen.getByText(CLIENT_WAITING_BODY)).toBeInTheDocument();
  });

  it('⚠ R2 — never says "scheduled start", the phrasing that was explicitly rejected', () => {
    for (const absentParty of PARTIES) {
      for (const phase of PHASES) {
        const container = renderWaiting(absentParty, phase);
        expect(container.textContent ?? '').not.toMatch(/scheduled start/i);
      }
    }
  });

  it('⚠ never names a gendered pronoun for either party', () => {
    for (const absentParty of PARTIES) {
      for (const phase of PHASES) {
        const container = renderWaiting(absentParty, phase);
        expect(container.textContent ?? '').not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
      }
    }
  });
});

describe('WaitingStage — the heading is the state, and the ref reaches it', () => {
  it('renders exactly one <h1>, and it carries the title', () => {
    const container = renderWaiting('expert', 'pre-start');

    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('⚠ hands headingRef the <h1>, focusable programmatically but out of the tab order', () => {
    const ref = createRef<HTMLHeadingElement>();
    renderWaiting('expert', 'pre-start', ref);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(ref.current).toBe(heading);
    // `tabIndex={-1}` is what lets the owner move focus here on a state transition without
    // putting a non-interactive element in the tab order. Do not "tidy" it away.
    expect(heading).toHaveAttribute('tabindex', '-1');
    ref.current?.focus();
    expect(heading).toHaveFocus();
  });
});

describe('WaitingStage — the glyph', () => {
  it('spins while the wait is live', () => {
    const container = renderWaiting('expert', 'running');

    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('stops spinning once the wait has settled', () => {
    const container = renderWaiting('expert', 'settled');

    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it('⚠ uses a DIFFERENT settled glyph per party — CircleSlash for a missed call, CircleCheck for a no-show', () => {
    // Compared by markup rather than by a lucide class name, so a vendor class rename cannot
    // turn this into a silent pass.
    const expertSettled = glyphMarkupOf(renderWaiting('expert', 'settled'));
    const clientSettled = glyphMarkupOf(renderWaiting('client', 'settled'));

    expect(expertSettled).not.toBe(clientSettled);
  });

  it('⚠ never conveys the state by the glyph alone — the copy always carries it', () => {
    const container = renderWaiting('expert', 'settled');

    // Every glyph is `aria-hidden`; a screen reader hears the heading and body, which state the
    // situation in words. That is also why `motion-reduce:animate-none` is safe.
    for (const svg of container.querySelectorAll('svg')) {
      expect(svg).toHaveAttribute('aria-hidden', 'true');
    }
    expect((container.textContent ?? '').length).toBeGreaterThan(0);
  });
});

describe('WaitingStage — accessibility', () => {
  for (const absentParty of PARTIES) {
    it(`has no accessibility violations (${absentParty} absent)`, async () => {
      const container = renderWaiting(absentParty, 'pre-start');

      expect(await axe(container)).toHaveNoViolations();
    });
  }
});

/**
 * ⚠⚠ RULING R10 — THE STATE THAT SHIPPED BROKEN.
 *
 * The frame hard-coded `absentParty="expert"` for EVERY viewer, so the delivering expert read the
 * CLIENT's billing promise — "You won't be charged for waiting" — on a money surface, which is
 * the exact misreading BAL-134 says costs an expert a settlement they had already earned. These
 * assertions are the ones that would have caught it.
 */
describe('WaitingStage — ⚠⚠ the viewer decides WHOSE clock is named (R10)', () => {
  it('an EXPERT waiting for the client is never told they will not be charged', () => {
    const container = renderWaiting('client', 'pre-start');

    expect(container.textContent ?? '').not.toContain(CLIENT_WAITING_BODY);
    expect(container.textContent ?? '').not.toMatch(/you won.?t be charged/i);
    // What they DO read: their own time, counted.
    expect(screen.getByText(waitingCopyFor('client', 'pre-start', INPUT).body)).toBeInTheDocument();
  });

  it('a CLIENT waiting for the expert IS told the timer has not started', () => {
    renderWaiting('expert', 'pre-start');

    expect(screen.getByText(CLIENT_WAITING_BODY)).toBeInTheDocument();
  });

  it('⚠⚠ with NO subject (both guest mounts) it names no party and no clock', () => {
    const container = renderNeutral();
    const text = container.textContent ?? '';

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(NEUTRAL_WAITING_COPY.title);
    expect(screen.getByText(NEUTRAL_WAITING_COPY.body)).toBeInTheDocument();
    // ⚠ THE THREE THINGS A VIEWER WITH NO SUBJECT MUST NEVER BE SHOWN.
    expect(text).not.toContain(CLIENT_WAITING_BODY);
    expect(text).not.toMatch(/charged/i);
    expect(text).not.toMatch(/counted|counting/i);
    expect(text).not.toMatch(/your expert|the scheduled time/i);
  });

  it('⚠ the neutral state still owns the one <h1>, and the ref still reaches it', () => {
    const ref = createRef<HTMLHeadingElement>();
    const container = renderNeutral(ref);

    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(ref.current).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('⚠ the neutral state never asserts an OUTCOME — it always spins', () => {
    const container = renderNeutral();

    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  it('has no accessibility violations with no subject', async () => {
    const container = renderNeutral();

    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * BAL-134 — ⚠⚠ **THE PROGRESSION HAD NO ANNOUNCEMENT.**
 *
 * The body paragraph is the sole carrier of the wait's progression and it was a plain `<p>`, so a
 * screen-reader expert waiting on a late client was never told that the wait had settled and that
 * they were free to leave — the single most consequential sentence on the surface.
 * `MeetingClockSlot` is correctly `aria-live="off"` (a per-second duration must not be announced),
 * so the announcement has nowhere else to go.
 */
describe('WaitingStage — ⚠⚠ the body is a live region (BAL-134)', () => {
  it('renders the body inside an <output>, not a bare <p>', () => {
    const container = renderWaiting('client', 'running');

    const live = container.querySelector('output');
    expect(live).not.toBeNull();
    expect(live?.textContent).toBe(waitingCopyFor('client', 'running', INPUT).body);
  });

  it('⚠⚠ it is <output>, NOT role="status" — SonarCloud S6819', () => {
    const container = renderWaiting('client', 'running');

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('output')).toHaveAttribute('aria-live', 'polite');
  });

  it('⚠ the announcement is the BODY, and the heading stays out of it', () => {
    renderWaiting('client', 'settled', undefined, factsFor('client'));

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.tagName).toBe('H1');
    expect(heading.closest('output')).toBeNull();
  });

  it('⚠⚠ the text CHANGES across the progression, which is what makes it announce', () => {
    // A live region announces on content change. The bodies must therefore genuinely differ per
    // phase, or the region would be silent exactly when it matters.
    const seen = new Set<string>();
    for (const phase of PHASES) {
      const container = renderWaiting('client', phase, undefined, factsFor('client'));
      seen.add(container.querySelector('output')?.textContent ?? '');
    }
    expect(seen.size).toBe(PHASES.length);
  });

  it('⚠ a re-render with the SAME phase produces the same text (no spurious announcement)', () => {
    const first = renderWaiting('client', 'running');
    const second = renderWaiting('client', 'running');

    expect(first.querySelector('output')?.textContent).toBe(
      second.querySelector('output')?.textContent
    );
  });

  it('the neutral (guest) mount carries the live region too', () => {
    const container = renderNeutral();
    expect(container.querySelector('output')?.textContent).toBe(NEUTRAL_WAITING_COPY.body);
  });

  it('has no accessibility violations with the live region present', async () => {
    expect(
      await axe(renderWaiting('client', 'settled', undefined, factsFor('client')))
    ).toHaveNoViolations();
  });
});

/**
 * BAL-134 — the component forwards the server facts, so the stage cannot render a sentence the
 * facts do not support. The exhaustive fact→string table lives in `waiting-copy.test.ts`; these
 * assert the WIRING.
 */
describe('WaitingStage — ⚠ the facts reach the copy (BAL-134)', () => {
  it('interpolates the SERVER-supplied no-show floor rather than a bundled literal', () => {
    const container = renderWaiting('client', 'near', undefined, {
      ...FACTS,
      noShowFloorMinutes: 20,
    });

    expect(container.textContent ?? '').toContain('20-minute mark');
    expect(container.textContent ?? '').not.toContain('15-minute');
  });

  it('⚠⚠ never claims a no-show settlement when the outcome does not say so', () => {
    const container = renderWaiting('client', 'settled', undefined, {
      ...FACTS,
      outcome: null,
    });

    expect(container.textContent ?? '').not.toContain('no-show');
    expect(container.textContent ?? '').not.toContain('payout');
  });

  it('⚠⚠ never claims counted time before the expert has been OBSERVED', () => {
    const container = renderWaiting('client', 'running', undefined, {
      ...FACTS,
      expertPresenceObserved: false,
    });

    expect(container.textContent ?? '').not.toContain('is counted');
  });
});
