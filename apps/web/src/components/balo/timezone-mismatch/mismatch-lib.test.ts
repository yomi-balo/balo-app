import { describe, it, expect } from 'vitest';
import {
  checkSomeHeadline,
  checkSomeStays,
  cityOf,
  consequenceBody,
  consequenceHeading,
  formatWallTime,
  keepLabel,
  mismatchDescription,
  mismatchTitle,
  rangeInstants,
  switchLabel,
  switchedToast,
  timeOffLine,
  travellingHint,
} from './mismatch-lib';

const SYDNEY = 'Australia/Sydney';
const LONDON = 'Europe/London';
const NINE_TO_FIVE = { startTime: '09:00', endTime: '17:00' };
// Sydney is on AEST (UTC+10) and London on BST (UTC+1) in July.
const JULY_NOON_UTC = new Date('2026-07-14T12:00:00Z');

describe('cityOf', () => {
  it('returns the city, or the raw id when the zone has none', () => {
    expect(cityOf(LONDON)).toBe('London');
    expect(cityOf('UTC')).toBe('UTC');
  });
});

describe('formatWallTime', () => {
  it('formats the hour, minute and period in the zone', () => {
    expect(formatWallTime(new Date('2026-07-13T23:00:00Z'), LONDON)).toBe('12:00 am');
    expect(formatWallTime(new Date('2026-07-14T07:30:00Z'), SYDNEY)).toBe('5:30 pm');
  });
});

describe('rangeInstants', () => {
  it('places Sydney 9–5 on the day it is in Sydney', () => {
    const { start, end } = rangeInstants(NINE_TO_FIVE, SYDNEY, JULY_NOON_UTC);
    expect(start.toISOString()).toBe('2026-07-13T23:00:00.000Z');
    expect(end.toISOString()).toBe('2026-07-14T07:00:00.000Z');
  });

  it('ends a range that crosses midnight on the next day', () => {
    const { start, end } = rangeInstants(
      { startTime: '22:00', endTime: '02:00' },
      SYDNEY,
      JULY_NOON_UTC
    );
    expect(end.getTime() - start.getTime()).toBe(4 * 60 * 60 * 1000);
  });
});

describe('mismatchTitle', () => {
  it('words the detected heading from both cities', () => {
    expect(mismatchTitle('detected', SYDNEY, LONDON)).toBe(
      'You’re in London, but your hours are set in Sydney time'
    );
  });

  it('words the manual heading as a question about the new zone', () => {
    expect(mismatchTitle('manual', SYDNEY, LONDON)).toBe('Switch your hours to London time?');
  });
});

describe('mismatchDescription', () => {
  const base = {
    fromTimezone: SYDNEY,
    toTimezone: LONDON,
    commonRange: NINE_TO_FIVE,
    now: JULY_NOON_UTC,
    toIsDevice: true,
  };

  it('reads Sydney 9–5 as 12:00 am – 8:00 am in London on a July date', () => {
    expect(mismatchDescription(base)).toBe(
      'It’s 1:00 pm here and 10:00 pm in Sydney. Your 9:00 am – 5:00 pm Sydney hours are 12:00 am – 8:00 am in London.'
    );
  });

  it('adds the weekday to the other clock when the day differs', () => {
    const now = new Date('2026-07-14T20:00:00Z');
    expect(mismatchDescription({ ...base, now })).toContain(
      'It’s 9:00 pm here and 6:00 am Wednesday in Sydney.'
    );
  });

  it('says "in {city}" instead of "here" for a manual pick that is not the device zone', () => {
    const text = mismatchDescription({ ...base, toIsDevice: false });
    expect(text.startsWith('It’s 1:00 pm in London and')).toBe(true);
    expect(text).not.toContain('here');
  });

  it('drops the range sentence when there is no usual range', () => {
    expect(mismatchDescription({ ...base, commonRange: null })).toBe(
      'It’s 1:00 pm here and 10:00 pm in Sydney.'
    );
  });
});

describe('consequence copy', () => {
  it('headlines the new zone', () => {
    expect(consequenceHeading(LONDON)).toBe('If you switch to London time');
  });

  it('keeps the hours in the old zone and reads them in the new one', () => {
    expect(consequenceBody(SYDNEY, LONDON, NINE_TO_FIVE, JULY_NOON_UTC)).toBe(
      'Your hours stay 9:00 am – 5:00 pm, read in London time, and every time clients can book moves with them.'
    );
  });

  it('omits the range when there is none', () => {
    expect(consequenceBody(SYDNEY, LONDON, null, JULY_NOON_UTC)).toBe(
      'Your hours stay the same, read in London time, and every time clients can book moves with them.'
    );
  });
});

describe('timeOffLine', () => {
  it('names a block by its dates in the new zone', () => {
    expect(timeOffLine({ startDate: '2026-12-24', endDate: '2027-01-02' }, LONDON)).toBe(
      'Your time off (24 Dec – 2 Jan) would be read in London time too.'
    );
  });

  it('names a single-day block once', () => {
    expect(timeOffLine({ startDate: '2026-12-24', endDate: '2026-12-24' }, LONDON)).toBe(
      'Your time off (24 Dec) would be read in London time too.'
    );
  });
});

describe('labels and toast', () => {
  it('builds the two button labels, the hint and the toast', () => {
    expect(keepLabel(SYDNEY)).toBe('Keep Sydney hours');
    expect(switchLabel(LONDON)).toBe('Switch to London time');
    expect(travellingHint(SYDNEY)).toBe(
      'Travelling but still working with the same clients? Keep Sydney hours.'
    );
    expect(switchedToast('London')).toBe(
      'Timezone updated. Your hours are now set in London time.'
    );
  });

  it('pluralises the affected-consultations headline', () => {
    expect(checkSomeHeadline(1)).toBe('1 upcoming consultation would fall outside your new hours.');
    expect(checkSomeHeadline(2)).toBe(
      '2 upcoming consultations would fall outside your new hours.'
    );
    expect(checkSomeStays(1)).toBe('It would stay booked at the current time:');
    expect(checkSomeStays(2)).toBe('They would stay booked at the current time:');
  });
});
