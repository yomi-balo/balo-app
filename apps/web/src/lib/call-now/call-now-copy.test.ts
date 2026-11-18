import { describe, expect, it } from 'vitest';
import { CALL_NOW_COPY, START_FAILURE_COPY } from './call-now-copy';

describe('CALL_NOW_COPY', () => {
  it('names the callee in the quiet lines and the confirm title', () => {
    expect(CALL_NOW_COPY.busy('Sandy')).toBe('Sandy is in another call');
    expect(CALL_NOW_COPY.lateNight('Sandy', '3:10 am')).toBe(
      'It’s 3:10 am for Sandy — book a time instead'
    );
    expect(CALL_NOW_COPY.confirmTitle('Sandy')).toBe('Call Sandy now?');
    expect(CALL_NOW_COPY.entryAriaLabel('Sandy')).toBe('Call Sandy now');
  });

  it('switches the calling body on whether the callee was texted', () => {
    expect(CALL_NOW_COPY.callingClient('Sandy', true)).toContain('We’ve texted Sandy');
    expect(CALL_NOW_COPY.callingClient('Sandy', false)).toContain('We’ve let Sandy know');
  });

  it('carries money only in the client terms and the funding body', () => {
    const moneyFree = [
      CALL_NOW_COPY.expertConfirm('Northwind'),
      CALL_NOW_COPY.callingExpert('Northwind'),
      CALL_NOW_COPY.noAnswerExpert('Northwind'),
      CALL_NOW_COPY.rowNote,
      CALL_NOW_COPY.rowNoteMoved('4:00 pm'),
    ];
    for (const line of moneyFree) {
      expect(line).not.toMatch(/A\$|\/min/);
    }
    expect(CALL_NOW_COPY.clientTerms('A$4.20/min · 15-minute minimum')).toContain('A$4.20/min');
  });

  it('states the ring countdown from the seconds it is given', () => {
    expect(CALL_NOW_COPY.ringRemaining(30)).toBe('We’ll keep trying for 30 more seconds.');
  });

  it('never offers a Cancel', () => {
    const rendered = Object.values(CALL_NOW_COPY).map((value) =>
      typeof value === 'function'
        ? (value as (...args: never[]) => string)('x' as never, true as never)
        : value
    );
    const strings = JSON.stringify([...rendered, ...Object.values(START_FAILURE_COPY)]);
    expect(strings.toLowerCase()).not.toContain('cancel');
  });
});

describe('START_FAILURE_COPY', () => {
  it('has a sentence for every failure code', () => {
    expect(Object.keys(START_FAILURE_COPY).sort((a, b) => a.localeCompare(b))).toEqual([
      'failed',
      'funding_unavailable',
      'in_place_not_eligible',
      'rate_limited',
      'session_expired',
      'unavailable',
      'venue_unavailable',
    ]);
    for (const sentence of Object.values(START_FAILURE_COPY)) {
      expect(sentence.length).toBeGreaterThan(0);
    }
  });
});
