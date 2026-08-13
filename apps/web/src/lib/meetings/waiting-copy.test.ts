import { describe, expect, it } from 'vitest';
import {
  CLIENT_WAITING_BODY,
  NEUTRAL_WAITING_COPY,
  resolveWaitingCopy,
  waitingCopyFor,
  waitingIconKindFor,
  type WaitingAbsentParty,
  type WaitingPhase,
} from './waiting-copy';

const PARTIES = ['expert', 'client'] as const satisfies readonly WaitingAbsentParty[];
const PHASES = [
  'pre-start',
  'running',
  'near',
  'settled',
] as const satisfies readonly WaitingPhase[];

const INPUT = { counterpartyFirstName: 'Dana', scheduledStartLabel: '10:00' };

describe('waitingCopyFor', () => {
  it('is total over both absent parties × all four phases', () => {
    for (const absentParty of PARTIES) {
      for (const phase of PHASES) {
        const copy = waitingCopyFor(absentParty, phase, INPUT);
        expect(copy.title.length).toBeGreaterThan(0);
        expect(copy.body.length).toBeGreaterThan(0);
      }
    }
  });

  it('⚠⚠ never says "scheduled start" — R2 rejected that phrasing as false for a late joiner', () => {
    for (const absentParty of PARTIES) {
      for (const phase of PHASES) {
        const { title, body } = waitingCopyFor(absentParty, phase, INPUT);
        expect(`${title} ${body}`.toLowerCase()).not.toContain('scheduled start');
      }
    }
  });

  it('⚠ never uses a gendered pronoun', () => {
    for (const absentParty of PARTIES) {
      for (const phase of PHASES) {
        const { title, body } = waitingCopyFor(absentParty, phase, INPUT);
        const words = `${title} ${body}`.toLowerCase().split(/[^a-z]+/);
        for (const banned of ['he', 'she', 'him', 'her', 'his', 'hers']) {
          expect(words).not.toContain(banned);
        }
      }
    }
  });

  it('⚠ never promises a payout for a no-show — that would invite hoping for one', () => {
    for (const phase of PHASES) {
      const { body } = waitingCopyFor('client', phase, INPUT);
      expect(body.toLowerCase()).not.toContain("you'll be paid");
      expect(body.toLowerCase()).not.toContain('you will be paid');
    }
  });

  it('names the counterparty rather than a role, on every phase', () => {
    for (const absentParty of PARTIES) {
      for (const phase of PHASES) {
        const { title } = waitingCopyFor(absentParty, phase, INPUT);
        expect(title).toContain('Dana');
      }
    }
  });
});

describe('waitingCopyFor — the expert waits (R2, Option A whole)', () => {
  it('pre-start states when counting begins, and that there is no waiting room', () => {
    expect(waitingCopyFor('client', 'pre-start', INPUT)).toEqual({
      title: 'Waiting for Dana to join',
      body: "Due to start at 10:00. Your time starts counting then — there's no waiting room, so Dana will come straight in.",
    });
  });

  it('running states the counting anchor and asks for nothing', () => {
    expect(waitingCopyFor('client', 'running', INPUT)).toEqual({
      title: 'Waiting for Dana to join',
      body: 'Your time is counted from 10:00. Nothing for you to do.',
    });
  });

  it('near names the 15-minute mark as a fact, not a countdown', () => {
    expect(waitingCopyFor('client', 'near', INPUT)).toEqual({
      title: 'Waiting for Dana to join',
      body: "Still counting. If Dana doesn't arrive, this settles as a no-show at the 15-minute mark.",
    });
  });

  it('settled releases the expert and promises the recap by email', () => {
    expect(waitingCopyFor('client', 'settled', INPUT)).toEqual({
      title: "Dana didn't join",
      body: "Settled as a no-show at the 15-minute minimum. You're free to leave — your recap and payout summary will be emailed.",
    });
  });
});

describe('waitingCopyFor — the client waits (R3)', () => {
  it('⚠⚠ pre-start is balo-in-meeting-ui.jsx:236, BYTE FOR BYTE', () => {
    expect(CLIENT_WAITING_BODY).toBe(
      "The consultation timer starts once your expert joins. You won't be charged for waiting."
    );
    expect(waitingCopyFor('expert', 'pre-start', INPUT).body).toBe(CLIENT_WAITING_BODY);
  });

  it('⚠ does NOT use the patch variant "once you\'re both in"', () => {
    expect(CLIENT_WAITING_BODY).not.toContain("you're both in");
  });

  it('running says nothing is being charged', () => {
    expect(waitingCopyFor('expert', 'running', INPUT).body).toBe(
      "Dana hasn't joined yet. Nothing is being charged — the timer only starts once they're here."
    );
  });

  it('near states the operational escalation once, plainly', () => {
    expect(waitingCopyFor('expert', 'near', INPUT).body).toBe(
      "Still no sign of Dana. We've flagged this to the Balo team and someone is looking into it. You haven't been charged."
    );
  });

  it('settled releases the hold and promises a rebook', () => {
    expect(waitingCopyFor('expert', 'settled', INPUT)).toEqual({
      title: "Dana didn't make it",
      body: "We're sorry this didn't happen. Nothing has been charged and your hold has been released. We'll be in touch to get you rebooked.",
    });
  });

  it('⚠ every client-facing phase reassures about charging', () => {
    for (const phase of PHASES) {
      expect(waitingCopyFor('expert', phase, INPUT).body.toLowerCase()).toContain('charg');
    }
  });
});

describe('waitingIconKindFor', () => {
  it('spins on every unsettled phase', () => {
    for (const absentParty of PARTIES) {
      for (const phase of ['pre-start', 'running', 'near'] as const) {
        expect(waitingIconKindFor(absentParty, phase)).toBe('spinner');
      }
    }
  });

  it('distinguishes a no-show from a missed call at settlement', () => {
    expect(waitingIconKindFor('client', 'settled')).toBe('no_show');
    expect(waitingIconKindFor('expert', 'settled')).toBe('missed_call');
  });
});

/**
 * ⚠⚠ RULING R10 — THE COPY WHEN WE DO NOT KNOW WHO IS MISSING.
 *
 * Both GUEST mounts land here structurally (no route provider ⇒ no viewer role, no counterparty,
 * no scheduled start). The requirement is exact: **name no party's clock.** Not the client's
 * billing promise, not the expert's counted time, and not "your expert" as a literal.
 */
describe('resolveWaitingCopy — the neutral half (R10)', () => {
  it('returns the party-specific copy when a subject is known', () => {
    expect(
      resolveWaitingCopy('pre-start', {
        absentParty: 'expert',
        counterpartyFirstName: 'Dana',
        scheduledStartLabel: '10:00',
      })
    ).toEqual(waitingCopyFor('expert', 'pre-start', INPUT));
  });

  it('⚠⚠ returns the NEUTRAL copy when the subject is unknown, on every phase', () => {
    for (const phase of PHASES) {
      expect(resolveWaitingCopy(phase, null)).toEqual(NEUTRAL_WAITING_COPY);
    }
  });

  it('⚠⚠ the neutral copy names no party and no clock', () => {
    const text = `${NEUTRAL_WAITING_COPY.title} ${NEUTRAL_WAITING_COPY.body}`.toLowerCase();

    // The three specific claims a viewer with no subject has no basis to be told.
    expect(text).not.toContain('charg');
    expect(text).not.toContain('count');
    expect(text).not.toContain('timer');
    expect(text).not.toContain('your expert');
    expect(text).not.toContain('scheduled');
    expect(text).not.toContain(CLIENT_WAITING_BODY.toLowerCase());
  });

  it('⚠ the neutral copy is still warm, and still gender-neutral', () => {
    const words = `${NEUTRAL_WAITING_COPY.title} ${NEUTRAL_WAITING_COPY.body}`
      .toLowerCase()
      .split(/[^a-z]+/);
    for (const banned of ['he', 'she', 'him', 'her', 'his', 'hers']) {
      expect(words).not.toContain(banned);
    }
    expect(NEUTRAL_WAITING_COPY.body.length).toBeGreaterThan(0);
  });

  it('⚠ an unknown party never asserts an OUTCOME — the glyph always spins', () => {
    for (const phase of PHASES) {
      expect(waitingIconKindFor(null, phase)).toBe('spinner');
    }
  });
});
