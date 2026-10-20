import { describe, it, expect } from 'vitest';
import { formatYourMoveDay, formatYourMoveDayTime, formatYourMoveFactAt } from './your-move-dates';

describe('your-move dates', () => {
  it('formats the day in the viewer zone', () => {
    expect(formatYourMoveDay('2026-10-21T22:00:00.000Z', 'Australia/Sydney')).toBe('Thu 22 Oct');
    expect(formatYourMoveDay('2026-10-21T22:00:00.000Z', 'UTC')).toBe('Wed 21 Oct');
  });

  it('formats day and time with a lowercase meridiem', () => {
    expect(formatYourMoveDayTime('2026-10-21T22:00:00.000Z', 'Australia/Sydney')).toBe(
      'Thu 22 Oct, 9:00 am'
    );
  });

  it('applies the fact template to the formatted day', () => {
    const iso = '2026-10-21T22:00:00.000Z';
    expect(formatYourMoveFactAt({ template: 'reply_by', iso }, 'Australia/Sydney')).toBe(
      'Reply by Thu 22 Oct'
    );
    expect(formatYourMoveFactAt({ template: 'since', iso }, 'UTC')).toBe('Since Wed 21 Oct');
    expect(formatYourMoveFactAt({ template: 'marked_complete', iso }, 'UTC')).toBe(
      'Marked complete Wed 21 Oct'
    );
  });
});
