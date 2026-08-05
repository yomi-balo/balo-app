import { describe, it, expect } from 'vitest';
import { computeMeetingClocks, type PresenceInterval } from './index';

const MIN = 60_000;
const T0 = new Date('2026-08-05T10:00:00.000Z');

/** `T0 + n` minutes. */
function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * MIN);
}

function interval(
  party: PresenceInterval['party'],
  fromMinutes: number,
  toMinutes: number | null
): PresenceInterval {
  return {
    party,
    joinedAt: at(fromMinutes),
    leftAt: toMinutes === null ? null : at(toMinutes),
  };
}

describe('computeMeetingClocks', () => {
  it('no intervals at all → both clocks zero, both anchors null', () => {
    const clocks = computeMeetingClocks([], at(60));

    expect(clocks).toEqual({
      expertPresentMs: 0,
      billableMs: 0,
      expertFirstJoinedAt: null,
      billableStartedAt: null,
    });
  });

  it('the straightforward case — expert 0→30, client 5→25 ⇒ billable is the 20-min overlap', () => {
    const clocks = computeMeetingClocks(
      [interval('expert', 0, 30), interval('client', 5, 25)],
      at(60)
    );

    expect(clocks.expertPresentMs).toBe(30 * MIN);
    expect(clocks.billableMs).toBe(20 * MIN);
    expect(clocks.expertFirstJoinedAt).toEqual(at(0));
    expect(clocks.billableStartedAt).toEqual(at(5));
  });

  it('THE REJOIN CASE — a client drop+rejoin yields ONE continuous span, not two fragments', () => {
    // expert 0→40; client 5→15, drops, rejoins 25→35.
    const clocks = computeMeetingClocks(
      [interval('expert', 0, 40), interval('client', 5, 15), interval('client', 25, 35)],
      at(60)
    );

    // A SUM would be 10 + 10 = 20 min (under-billing the call by the 10-min gap).
    // The SPAN is 5 → 35 = 30 min, gap INCLUSIVE. The timer never restarted.
    expect(clocks.billableMs).toBe(30 * MIN);
    expect(clocks.billableStartedAt).toEqual(at(5));
    expect(clocks.expertPresentMs).toBe(40 * MIN);
  });

  it('an EXPERT drop+rejoin does not move the first-join anchor or restart the clock', () => {
    const clocks = computeMeetingClocks(
      [interval('expert', 0, 10), interval('expert', 20, 30), interval('client', 2, 28)],
      at(60)
    );

    expect(clocks.expertFirstJoinedAt).toEqual(at(0));
    expect(clocks.expertPresentMs).toBe(30 * MIN); // 0 → 30, gap inclusive
    expect(clocks.billableMs).toBe(26 * MIN); // 2 → 28, gap inclusive
    expect(clocks.billableStartedAt).toEqual(at(2));
  });

  it('expert only, no client ever ⇒ billableMs 0 with a running expert clock (the no-show input)', () => {
    const clocks = computeMeetingClocks([interval('expert', 0, 15)], at(60));

    expect(clocks.expertPresentMs).toBe(15 * MIN);
    expect(clocks.billableMs).toBe(0);
    expect(clocks.billableStartedAt).toBeNull();
    expect(clocks.expertFirstJoinedAt).toEqual(at(0));
  });

  it('client only, expert never joined ⇒ both clocks zero and both anchors null', () => {
    const clocks = computeMeetingClocks([interval('client', 0, 15)], at(60));

    expect(clocks.expertPresentMs).toBe(0);
    expect(clocks.billableMs).toBe(0);
    expect(clocks.expertFirstJoinedAt).toBeNull();
    expect(clocks.billableStartedAt).toBeNull();
  });

  it('an observer NEVER makes a meeting billable', () => {
    const clocks = computeMeetingClocks(
      [interval('expert', 0, 20), interval('observer', 0, 20)],
      at(60)
    );

    expect(clocks.expertPresentMs).toBe(20 * MIN);
    expect(clocks.billableMs).toBe(0);
    expect(clocks.billableStartedAt).toBeNull();
  });

  it('an observer alongside a client neither extends nor shortens the billable span', () => {
    const withObserver = computeMeetingClocks(
      [interval('expert', 0, 30), interval('client', 10, 20), interval('observer', 0, 30)],
      at(60)
    );
    const withoutObserver = computeMeetingClocks(
      [interval('expert', 0, 30), interval('client', 10, 20)],
      at(60)
    );

    expect(withObserver).toEqual(withoutObserver);
  });

  it('still-open intervals run to `now`', () => {
    const clocks = computeMeetingClocks(
      [interval('expert', 0, null), interval('client', 5, null)],
      at(25)
    );

    expect(clocks.expertPresentMs).toBe(25 * MIN);
    expect(clocks.billableMs).toBe(20 * MIN);
    expect(clocks.billableStartedAt).toEqual(at(5));
  });

  it('a zero-length join blip is a real event — a 0 ms clock, not a dropped interval', () => {
    const clocks = computeMeetingClocks(
      [interval('expert', 10, 10), interval('client', 10, 10)],
      at(60)
    );

    expect(clocks.expertPresentMs).toBe(0);
    expect(clocks.billableMs).toBe(0);
    // The anchors are still recorded — the parties WERE both in the room, instantaneously.
    expect(clocks.expertFirstJoinedAt).toEqual(at(10));
    expect(clocks.billableStartedAt).toEqual(at(10));
  });

  it('client first, expert second — the billable clock starts when the EXPERT arrives', () => {
    const clocks = computeMeetingClocks(
      [interval('client', 0, 40), interval('expert', 12, 40)],
      at(60)
    );

    expect(clocks.expertFirstJoinedAt).toEqual(at(12));
    expect(clocks.billableStartedAt).toEqual(at(12));
    expect(clocks.billableMs).toBe(28 * MIN);
    expect(clocks.expertPresentMs).toBe(28 * MIN);
  });

  it('non-overlapping presence (client leaves BEFORE the expert joins) ⇒ never billable', () => {
    const clocks = computeMeetingClocks(
      [interval('client', 0, 5), interval('expert', 10, 30)],
      at(60)
    );

    expect(clocks.expertPresentMs).toBe(20 * MIN);
    expect(clocks.billableMs).toBe(0);
    expect(clocks.billableStartedAt).toBeNull();
  });

  it('two concurrent clients — the billable span covers the union of their presence', () => {
    const clocks = computeMeetingClocks(
      [interval('expert', 0, 60), interval('client', 5, 20), interval('client', 15, 45)],
      at(90)
    );

    expect(clocks.billableStartedAt).toEqual(at(5));
    expect(clocks.billableMs).toBe(40 * MIN); // 5 → 45
  });

  it('input order is irrelevant', () => {
    const forward = computeMeetingClocks(
      [interval('expert', 0, 40), interval('client', 5, 15), interval('client', 25, 35)],
      at(60)
    );
    const shuffled = computeMeetingClocks(
      [interval('client', 25, 35), interval('client', 5, 15), interval('expert', 0, 40)],
      at(60)
    );

    expect(shuffled).toEqual(forward);
  });
});
