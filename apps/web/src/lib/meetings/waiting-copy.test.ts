import { describe, expect, it } from 'vitest';
import {
  CLIENT_WAITING_BODY,
  NEUTRAL_WAITING_COPY,
  UNKNOWN_WAITING_FACTS,
  resolveWaitingCopy,
  waitingCopyFor,
  waitingIconKindFor,
  type WaitingAbsentParty,
  type WaitingFacts,
  type WaitingPhase,
} from './waiting-copy';

/**
 * ⚠⚠ **WHY THE SWEEPS BELOW ARE NOT THE GUARD ANY MORE.**
 *
 * The previous version of this file asserted that the phrase `"scheduled start"` appeared in no
 * string. It passed for months over a `running` body that read *"Your time is counted from
 * {scheduledStartLabel}."* — because the string INTERPOLATED A FORMATTED TIME, so the banned
 * phrase never literally appeared while the false claim it was written to stop survived intact.
 * A grep for a phrase cannot see a claim assembled from a variable.
 *
 * Every sentence is therefore pinned by EQUALITY against its exact expected text. The sweeps stay
 * as cheap totality/register checks, but they are no longer load-bearing.
 */

const PARTIES = ['expert', 'client'] as const satisfies readonly WaitingAbsentParty[];
const PHASES = [
  'pre-start',
  'running',
  'near',
  'settled',
] as const satisfies readonly WaitingPhase[];

/**
 * The everything-known facts: the server sent the floor, the expert has been OBSERVED in the
 * room, and the outcome is the one each party's `settled` arm is written for.
 */
const FACTS: WaitingFacts = {
  noShowFloorMinutes: 15,
  outcome: null,
  expertPresenceObserved: true,
};

/** ⚠ The outcome that earns each side's settled sentence — `no_show_client` for the expert. */
function factsFor(absentParty: WaitingAbsentParty): WaitingFacts {
  return {
    ...FACTS,
    outcome: absentParty === 'client' ? 'no_show_client' : 'missed_call',
  };
}

const INPUT = { counterpartyFirstName: 'Dana', scheduledStartLabel: '10:00', ...FACTS };

function copy(absentParty: WaitingAbsentParty, phase: WaitingPhase, facts: WaitingFacts = FACTS) {
  return waitingCopyFor(absentParty, phase, {
    counterpartyFirstName: 'Dana',
    scheduledStartLabel: '10:00',
    ...facts,
  });
}

describe('waitingCopyFor', () => {
  it('is total over both absent parties × all four phases', () => {
    for (const absentParty of PARTIES) {
      for (const phase of PHASES) {
        const result = copy(absentParty, phase);
        expect(result.title.length).toBeGreaterThan(0);
        expect(result.body.length).toBeGreaterThan(0);
      }
    }
  });

  it('is total with NOTHING known either — every unknown fact still yields real copy', () => {
    for (const absentParty of PARTIES) {
      for (const phase of PHASES) {
        const result = copy(absentParty, phase, UNKNOWN_WAITING_FACTS);
        expect(result.title.length).toBeGreaterThan(0);
        expect(result.body.length).toBeGreaterThan(0);
      }
    }
  });

  it('⚠ never uses a gendered pronoun', () => {
    for (const absentParty of PARTIES) {
      for (const phase of PHASES) {
        for (const facts of [FACTS, UNKNOWN_WAITING_FACTS, factsFor(absentParty)]) {
          const { title, body } = copy(absentParty, phase, facts);
          const words = `${title} ${body}`.toLowerCase().split(/[^a-z]+/);
          for (const banned of ['he', 'she', 'him', 'her', 'his', 'hers']) {
            expect(words).not.toContain(banned);
          }
        }
      }
    }
  });

  it('⚠ never promises a payout for a no-show — that would invite hoping for one', () => {
    for (const phase of PHASES) {
      const { body } = copy('client', phase, factsFor('client'));
      expect(body.toLowerCase()).not.toContain("you'll be paid");
      expect(body.toLowerCase()).not.toContain('you will be paid');
    }
  });

  it('names the counterparty rather than a role, on every phase it can', () => {
    for (const absentParty of PARTIES) {
      for (const phase of PHASES) {
        const { title } = copy(absentParty, phase, factsFor(absentParty));
        expect(title).toContain('Dana');
      }
    }
  });
});

/**
 * ⚠⚠ **BAL-134's CENTRAL CORRECTION.** The expert-present clock starts at the LATER of the
 * scheduled start and the expert's actual join, so an expert who joins a 10:00 call at 10:05 is
 * anchored at 10:05 and settles at 10:20. Copy anchored on the scheduled start over-promises them
 * by five minutes, on the one surface this ticket exists to make trustworthy.
 */
describe('waitingCopyFor — the expert waits (R2, Option A whole)', () => {
  it('⚠⚠ running is anchored on THE JOIN, not on the scheduled start', () => {
    expect(copy('client', 'running')).toEqual({
      title: 'Waiting for Dana to join',
      body: 'Your time is counted from when you joined. Nothing for you to do.',
    });
  });

  it('⚠⚠ running names NO time at all — the anchor is not a clock the browser can state', () => {
    const { body } = copy('client', 'running');
    // The formatted scheduled start must not appear: interpolating it IS the bug, whether or not
    // the words "scheduled start" are present.
    expect(body).not.toContain('10:00');
  });

  it('⚠ pre-start is join-anchored too — the truth is max(scheduled, join)', () => {
    expect(copy('client', 'pre-start')).toEqual({
      title: 'Waiting for Dana to join',
      body: "Due to start at 10:00. Your time starts counting the moment you join — there's no waiting room, so Dana will come straight in.",
    });
  });

  it('⚠ pre-start states the scheduled start as a FACT, which is the one honest use of it', () => {
    // "Due to start at 10:00" is a claim about the calendar, not about the clock.
    expect(copy('client', 'pre-start').body).toContain('Due to start at 10:00');
    expect(copy('client', 'pre-start').body).not.toContain('counting then');
  });

  it('near interpolates the SERVER-supplied floor rather than a bundled literal', () => {
    expect(copy('client', 'near')).toEqual({
      title: 'Waiting for Dana to join',
      body: "Still counting. If Dana doesn't arrive, this settles as a no-show at the 15-minute mark.",
    });
    expect(copy('client', 'near', { ...FACTS, noShowFloorMinutes: 20 }).body).toContain(
      'the 20-minute mark'
    );
  });

  it('⚠⚠ near names NO number when the server did not send one', () => {
    const { body } = copy('client', 'near', { ...FACTS, noShowFloorMinutes: null });
    expect(body).toBe(
      "Still counting. If Dana doesn't arrive, this settles as a no-show once the minimum is reached."
    );
    expect(body).not.toContain('15');
  });

  it('settled on a no_show_client releases the expert and promises the recap', () => {
    expect(copy('client', 'settled', factsFor('client'))).toEqual({
      title: "Dana didn't join",
      body: "Settled as a no-show at the 15-minute minimum. You're free to leave — your recap and payout summary will be emailed.",
    });
  });

  it('settled interpolates an OVERRIDDEN floor, and omits the number when unknown', () => {
    expect(
      copy('client', 'settled', { ...factsFor('client'), noShowFloorMinutes: 20 }).body
    ).toContain('the 20-minute minimum');
    const unknown = copy('client', 'settled', {
      ...factsFor('client'),
      noShowFloorMinutes: null,
    }).body;
    expect(unknown).toContain('at the minimum');
    expect(unknown).not.toContain('15');
  });
});

/**
 * ⚠⚠ **A TERMINAL STATUS IS NOT EVIDENCE OF A MONEY OUTCOME.** `resolveWaitingPhase` returns
 * `settled` for ANY terminal status without consulting the outcome, so the expert's screen used
 * to claim a 15-minute no-show settlement — and a payout summary — within one poll tick of the
 * CLIENT ending the call at minute three. That path carries `outcome: null`, and so do the idle
 * end and every other human End.
 */
describe('waitingCopyFor — settled branches on the OUTCOME (BAL-134 / ADR-1049)', () => {
  const NON_SETTLING = [null, 'missed_call', 'completed'] as const;

  it('⚠⚠ the expert is told NO settlement happened on every non-no-show outcome', () => {
    for (const outcome of NON_SETTLING) {
      const { title, body } = copy('client', 'settled', { ...FACTS, outcome });
      expect({ outcome, title, body }).toEqual({
        outcome,
        title: 'This call has ended',
        body: "You're free to leave. We're working out how it settles, and your recap will be emailed.",
      });
    }
  });

  it('⚠ and none of those claim a no-show, a minimum or a payout', () => {
    for (const outcome of NON_SETTLING) {
      const text = `${copy('client', 'settled', { ...FACTS, outcome }).body}`.toLowerCase();
      expect(text).not.toContain('no-show');
      expect(text).not.toContain('minimum');
      expect(text).not.toContain('payout');
      expect(text).not.toContain('15');
    }
  });

  it('⚠⚠ the client is told NO hold was released on every non-missed-call outcome', () => {
    for (const outcome of [null, 'no_show_client', 'completed'] as const) {
      const { title, body } = copy('expert', 'settled', { ...FACTS, outcome });
      expect({ outcome, title, body }).toEqual({
        outcome,
        title: 'This call has ended',
        body: "You haven't been charged for waiting. We're working out the details and will confirm by email.",
      });
      expect(body.toLowerCase()).not.toContain('hold has been released');
    }
  });

  it('⚠ the missed_call copy is UNCHANGED, and still carries no rebooking CTA', () => {
    expect(copy('expert', 'settled', factsFor('expert'))).toEqual({
      title: "Dana didn't make it",
      body: "We're sorry this didn't happen. Nothing has been charged and your hold has been released. We'll be in touch to get you rebooked.",
    });
  });
});

/**
 * ⚠⚠ **THE PRESENCE-OBSERVATION WINDOW.** Presence is written from Daily's webhooks
 * server-to-server, so the phase can advance to `running` seconds before the expert's interval is
 * observed. In that window the server measures `expertPresentMs` as ZERO and the TopBar chip
 * correctly reads "Not started" — while the body was simultaneously saying "Your time is
 * counted…". The copy was the wrong one of the two.
 */
describe('waitingCopyFor — the expert has not been OBSERVED yet (BAL-134)', () => {
  const UNSEEN: WaitingFacts = { ...FACTS, expertPresenceObserved: false };

  it('⚠⚠ running claims NO counted time while no expert interval is open', () => {
    const { body } = copy('client', 'running', UNSEEN);
    expect(body).not.toContain('is counted');
    expect(body).toBe(copy('client', 'pre-start', UNSEEN).body);
  });

  it('⚠ near does not claim to be "still counting" either', () => {
    const { body } = copy('client', 'near', UNSEEN);
    expect(body).not.toContain('Still counting');
    expect(body).toBe(copy('client', 'pre-start', UNSEEN).body);
  });

  it('⚠ the guard lifts the instant presence is observed', () => {
    expect(copy('client', 'running', { ...UNSEEN, expertPresenceObserved: true }).body).toBe(
      'Your time is counted from when you joined. Nothing for you to do.'
    );
  });

  it('⚠ settled is NOT rewritten by it — a terminal meeting is terminal either way', () => {
    expect(copy('client', 'settled', { ...UNSEEN, outcome: 'no_show_client' }).body).toContain(
      'Settled as a no-show'
    );
  });

  it('⚠ the CLIENT-side progression is untouched — it claims no counted time on any phase', () => {
    for (const phase of PHASES) {
      expect(copy('expert', phase, UNSEEN)).toEqual(copy('expert', phase, FACTS));
    }
  });
});

describe('waitingCopyFor — the client waits (R3)', () => {
  it('⚠⚠ pre-start is balo-in-meeting-ui.jsx:236, BYTE FOR BYTE', () => {
    expect(CLIENT_WAITING_BODY).toBe(
      "The consultation timer starts once your expert joins. You won't be charged for waiting."
    );
    expect(copy('expert', 'pre-start').body).toBe(CLIENT_WAITING_BODY);
  });

  it('⚠ does NOT use the patch variant "once you\'re both in"', () => {
    expect(CLIENT_WAITING_BODY).not.toContain("you're both in");
  });

  it('running says nothing is being charged', () => {
    expect(copy('expert', 'running').body).toBe(
      "Dana hasn't joined yet. Nothing is being charged — the timer only starts once they're here."
    );
  });

  it('near states the operational escalation once, plainly', () => {
    expect(copy('expert', 'near').body).toBe(
      "Still no sign of Dana. We've flagged this to the Balo team and someone is looking into it. You haven't been charged."
    );
  });

  it('⚠ every client-facing phase reassures about charging, on every outcome', () => {
    for (const phase of PHASES) {
      for (const outcome of [null, 'missed_call', 'completed'] as const) {
        expect(copy('expert', phase, { ...FACTS, outcome }).body.toLowerCase()).toContain('charg');
      }
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
 * Both GUEST mounts land here (N5, fix-round-2 — corrected: NOT "no route provider" — both DO
 * mount one; `waiting` arrives on the member-join response envelope, which a guest never calls,
 * so both guest mounts explicitly pass `waiting={null}`, hence no viewer role, no counterparty,
 * no scheduled start). The requirement is exact: **name no party's clock.** Not the client's
 * billing promise, not the expert's counted time, and not "your expert" as a literal.
 */
describe('resolveWaitingCopy — the neutral half (R10)', () => {
  it('returns the party-specific copy when a subject is known', () => {
    expect(
      resolveWaitingCopy(
        'pre-start',
        {
          absentParty: 'expert',
          counterpartyFirstName: 'Dana',
          scheduledStartLabel: '10:00',
        },
        FACTS
      )
    ).toEqual(waitingCopyFor('expert', 'pre-start', INPUT));
  });

  it('⚠ forwards the facts, so the copy the stage renders is the one the facts describe', () => {
    const subject = {
      absentParty: 'client',
      counterpartyFirstName: 'Dana',
      scheduledStartLabel: '10:00',
    } as const;
    expect(
      resolveWaitingCopy('near', subject, { ...FACTS, noShowFloorMinutes: 20 }).body
    ).toContain('the 20-minute mark');
    expect(resolveWaitingCopy('running', subject, UNKNOWN_WAITING_FACTS).body).not.toContain(
      'is counted'
    );
  });

  it('⚠⚠ returns the NEUTRAL copy when the subject is unknown, on every phase', () => {
    for (const phase of PHASES) {
      expect(resolveWaitingCopy(phase, null, FACTS)).toEqual(NEUTRAL_WAITING_COPY);
      expect(resolveWaitingCopy(phase, null, UNKNOWN_WAITING_FACTS)).toEqual(NEUTRAL_WAITING_COPY);
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

describe('UNKNOWN_WAITING_FACTS', () => {
  it('⚠ every unknown is the answer that makes the copy claim LESS', () => {
    expect(UNKNOWN_WAITING_FACTS).toEqual({
      noShowFloorMinutes: null,
      outcome: null,
      expertPresenceObserved: false,
    });
  });
});
