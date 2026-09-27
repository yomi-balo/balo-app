import { describe, expect, it } from 'vitest';
import {
  bookingReplayWindowMatches,
  classifyBookingReplay,
  type BookingReplayExisting,
  type BookingReplayProbe,
} from './booking-replay';

/**
 * BAL-474 (D8.6) — THE ONE DEFINITION of "this key names this booking", shared by the API probe
 * and the web action's replay skip. The rules are unchanged from `provision-meeting.ts`'s
 * `lookupBookingReplay` (BAL-400): the window first, then the context; any mismatch is a conflict.
 */

const MINUTE_MS = 60_000;
const START = new Date(Math.ceil(Date.now() / MINUTE_MS) * MINUTE_MS + 60 * MINUTE_MS);
const END = new Date(START.getTime() + 30 * MINUTE_MS);
const CASE_ID = '11111111-1111-4111-8111-111111111111';

const PROBE: BookingReplayProbe = {
  contextType: 'case',
  contextId: CASE_ID,
  scheduledStart: START,
  scheduledEnd: END,
};

function existing(overrides: Partial<BookingReplayExisting> = {}): BookingReplayExisting {
  return {
    scheduledStart: new Date(START.getTime()),
    scheduledEnd: new Date(END.getTime()),
    contexts: [{ contextType: 'case', contextId: CASE_ID }],
    ...overrides,
  };
}

describe('classifyBookingReplay', () => {
  it('none — no meeting exists under the key', () => {
    expect(classifyBookingReplay(undefined, PROBE)).toBe('none');
  });

  it('match — the same window (compared by instant, not identity) and this context', () => {
    expect(classifyBookingReplay(existing(), PROBE)).toBe('match');
  });

  it('conflict — a different start', () => {
    expect(
      classifyBookingReplay(
        existing({ scheduledStart: new Date(START.getTime() + MINUTE_MS) }),
        PROBE
      )
    ).toBe('conflict');
  });

  it('conflict — a different end', () => {
    expect(
      classifyBookingReplay(existing({ scheduledEnd: new Date(END.getTime() + MINUTE_MS) }), PROBE)
    ).toBe('conflict');
  });

  it('conflict — the same window but another case', () => {
    expect(
      classifyBookingReplay(
        existing({
          contexts: [{ contextType: 'case', contextId: '22222222-2222-4222-8222-222222222222' }],
        }),
        PROBE
      )
    ).toBe('conflict');
  });

  it('conflict — the same id under another context type', () => {
    expect(
      classifyBookingReplay(
        existing({ contexts: [{ contextType: 'project_kickoff', contextId: CASE_ID }] }),
        PROBE
      )
    ).toBe('conflict');
  });

  it('exact-duplicate context rows are not ambiguity — still a match', () => {
    expect(
      classifyBookingReplay(
        existing({
          contexts: [
            { contextType: 'case', contextId: CASE_ID },
            { contextType: 'case', contextId: CASE_ID },
          ],
        }),
        PROBE
      )
    ).toBe('match');
  });

  it('the window is compared first — a window mismatch is a conflict even with no contexts read', () => {
    expect(
      classifyBookingReplay(
        existing({ scheduledStart: new Date(START.getTime() - MINUTE_MS), contexts: [] }),
        PROBE
      )
    ).toBe('conflict');
    expect(bookingReplayWindowMatches(existing(), PROBE)).toBe(true);
    expect(
      bookingReplayWindowMatches(existing({ scheduledEnd: new Date(END.getTime() + 1) }), PROBE)
    ).toBe(false);
  });
});
