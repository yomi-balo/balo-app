import { describe, it, expect } from 'vitest';
import {
  deriveConsultationOrdinal,
  formatOrdinalLine,
  ordinalSuffix,
  type MeetingOrdinalInput,
} from './derive-consultation-ordinal';

const iso = (value: string): Date => new Date(value);

function meeting(over: Partial<MeetingOrdinalInput> & { id: string }): MeetingOrdinalInput {
  return {
    scheduledStart: iso('2026-07-01T10:00:00Z'),
    startedAt: null,
    status: 'ended',
    outcome: 'completed',
    ...over,
  };
}

describe('deriveConsultationOrdinal', () => {
  it('orders by COALESCE(startedAt, scheduledStart), not by scheduledStart alone', () => {
    // `late` was BOOKED first but STARTED second — it must be numbered by when it happened.
    const late = meeting({
      id: 'a',
      scheduledStart: iso('2026-07-01T09:00:00Z'),
      startedAt: iso('2026-07-01T14:00:00Z'),
    });
    const early = meeting({
      id: 'b',
      scheduledStart: iso('2026-07-01T10:00:00Z'),
      startedAt: iso('2026-07-01T10:05:00Z'),
    });

    expect(deriveConsultationOrdinal([late, early], 'b').ordinal).toBe(1);
    expect(deriveConsultationOrdinal([late, early], 'a').ordinal).toBe(2);
  });

  it('falls back to scheduledStart when a meeting never started', () => {
    const first = meeting({ id: 'a', scheduledStart: iso('2026-07-01T09:00:00Z') });
    const second = meeting({ id: 'b', scheduledStart: iso('2026-07-02T09:00:00Z') });
    expect(deriveConsultationOrdinal([second, first], 'b').ordinal).toBe(2);
  });

  it('breaks an exact tie on id, so the answer is stable across refreshes', () => {
    const at = iso('2026-07-01T09:00:00Z');
    const zed = meeting({ id: 'zzz', scheduledStart: at });
    const aaa = meeting({ id: 'aaa', scheduledStart: at });
    expect(deriveConsultationOrdinal([zed, aaa], 'aaa').ordinal).toBe(1);
    expect(deriveConsultationOrdinal([zed, aaa], 'zzz').ordinal).toBe(2);
    // And the reverse input order gives the same answer.
    expect(deriveConsultationOrdinal([aaa, zed], 'zzz').ordinal).toBe(2);
  });

  it('excludes cancelled meetings from the ORDERING (they never occupied a consultation)', () => {
    const cancelled = meeting({
      id: 'a',
      scheduledStart: iso('2026-07-01T09:00:00Z'),
      status: 'cancelled',
      outcome: null,
    });
    const held = meeting({ id: 'b', scheduledStart: iso('2026-07-02T09:00:00Z') });
    expect(deriveConsultationOrdinal([cancelled, held], 'b').ordinal).toBe(1);
  });

  it('gives a CANCELLED meeting no ordinal of its own', () => {
    const cancelled = meeting({ id: 'a', status: 'cancelled', outcome: null });
    const held = meeting({ id: 'b', scheduledStart: iso('2026-07-02T09:00:00Z') });
    expect(deriveConsultationOrdinal([cancelled, held], 'a').ordinal).toBeNull();
  });

  it('DOES give a NOT-HELD meeting an ordinal — it occupied a slot', () => {
    const first = meeting({ id: 'a', scheduledStart: iso('2026-07-01T09:00:00Z') });
    const noShow = meeting({
      id: 'b',
      scheduledStart: iso('2026-07-02T09:00:00Z'),
      outcome: 'no_show_client',
    });
    expect(deriveConsultationOrdinal([first, noShow], 'b').ordinal).toBe(2);
  });

  it('counts only ended + completed meetings in heldCount', () => {
    const rows = [
      meeting({ id: 'a' }),
      meeting({ id: 'b', outcome: 'no_show_client' }),
      meeting({ id: 'c', outcome: 'missed_call' }),
      meeting({ id: 'd', status: 'cancelled', outcome: null }),
      meeting({ id: 'e', status: 'in_progress', outcome: null }),
      meeting({ id: 'f' }),
    ];
    expect(deriveConsultationOrdinal(rows, 'a').heldCount).toBe(2);
  });

  it('returns a null ordinal for an empty sibling set', () => {
    expect(deriveConsultationOrdinal([], 'a')).toEqual({ ordinal: null, heldCount: 0 });
  });

  it('returns a null ordinal when this meeting is not in the set', () => {
    expect(deriveConsultationOrdinal([meeting({ id: 'a' })], 'missing').ordinal).toBeNull();
  });

  it("does not mutate the caller's array", () => {
    const rows = [
      meeting({ id: 'b', scheduledStart: iso('2026-07-02T09:00:00Z') }),
      meeting({ id: 'a', scheduledStart: iso('2026-07-01T09:00:00Z') }),
    ];
    deriveConsultationOrdinal(rows, 'a');
    expect(rows.map((row) => row.id)).toEqual(['b', 'a']);
  });
});

describe('ordinalSuffix', () => {
  it('uses st / nd / rd / th', () => {
    expect(ordinalSuffix(1)).toBe('st');
    expect(ordinalSuffix(2)).toBe('nd');
    expect(ordinalSuffix(3)).toBe('rd');
    expect(ordinalSuffix(4)).toBe('th');
    expect(ordinalSuffix(21)).toBe('st');
    expect(ordinalSuffix(22)).toBe('nd');
    expect(ordinalSuffix(23)).toBe('rd');
  });

  it('uses th for the 11 / 12 / 13 exceptions', () => {
    expect(ordinalSuffix(11)).toBe('th');
    expect(ordinalSuffix(12)).toBe('th');
    expect(ordinalSuffix(13)).toBe('th');
    expect(ordinalSuffix(111)).toBe('th');
  });
});

describe('formatOrdinalLine', () => {
  it('renders the line for a known ordinal', () => {
    expect(formatOrdinalLine(3)).toBe('3rd consultation on this case');
  });

  it('omits the line entirely when there is no ordinal', () => {
    expect(formatOrdinalLine(null)).toBeNull();
  });
});
