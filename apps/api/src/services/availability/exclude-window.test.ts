import { describe, expect, it } from 'vitest';
import { subtractInterval } from './exclude-window.js';

const d = (iso: string): Date => new Date(iso);

describe('subtractInterval — T-AVAIL-EX', () => {
  it('no overlap — block passes through unchanged', () => {
    const blocks = [{ startAt: d('2026-09-01T08:00:00Z'), endAt: d('2026-09-01T09:00:00Z') }];
    const window = { startAt: d('2026-09-01T10:00:00Z'), endAt: d('2026-09-01T11:00:00Z') };
    expect(subtractInterval(blocks, window)).toEqual(blocks);
  });

  it('full containment — the window swallows the whole block, dropping it', () => {
    const blocks = [{ startAt: d('2026-09-01T10:15:00Z'), endAt: d('2026-09-01T10:45:00Z') }];
    const window = { startAt: d('2026-09-01T10:00:00Z'), endAt: d('2026-09-01T11:00:00Z') };
    expect(subtractInterval(blocks, window)).toEqual([]);
  });

  it('overlap at the HEAD of the block — clips to what remains after the window', () => {
    const blocks = [{ startAt: d('2026-09-01T09:30:00Z'), endAt: d('2026-09-01T11:00:00Z') }];
    const window = { startAt: d('2026-09-01T09:00:00Z'), endAt: d('2026-09-01T10:00:00Z') };
    expect(subtractInterval(blocks, window)).toEqual([
      { startAt: d('2026-09-01T10:00:00Z'), endAt: d('2026-09-01T11:00:00Z') },
    ]);
  });

  it('overlap at the TAIL of the block — clips to what remains before the window', () => {
    const blocks = [{ startAt: d('2026-09-01T09:00:00Z'), endAt: d('2026-09-01T10:30:00Z') }];
    const window = { startAt: d('2026-09-01T10:00:00Z'), endAt: d('2026-09-01T11:00:00Z') };
    expect(subtractInterval(blocks, window)).toEqual([
      { startAt: d('2026-09-01T09:00:00Z'), endAt: d('2026-09-01T10:00:00Z') },
    ]);
  });

  it('the window sits STRICTLY INSIDE a block — splits it into two, partial overlaps still block', () => {
    const blocks = [{ startAt: d('2026-09-01T08:00:00Z'), endAt: d('2026-09-01T12:00:00Z') }];
    const window = { startAt: d('2026-09-01T09:00:00Z'), endAt: d('2026-09-01T10:00:00Z') };
    expect(subtractInterval(blocks, window)).toEqual([
      { startAt: d('2026-09-01T08:00:00Z'), endAt: d('2026-09-01T09:00:00Z') },
      { startAt: d('2026-09-01T10:00:00Z'), endAt: d('2026-09-01T12:00:00Z') },
    ]);
  });

  it('empty input returns empty output', () => {
    const window = { startAt: d('2026-09-01T09:00:00Z'), endAt: d('2026-09-01T10:00:00Z') };
    expect(subtractInterval([], window)).toEqual([]);
  });

  it('multiple blocks — only the overlapping ones are affected', () => {
    const blocks = [
      { startAt: d('2026-09-01T06:00:00Z'), endAt: d('2026-09-01T07:00:00Z') },
      { startAt: d('2026-09-01T09:15:00Z'), endAt: d('2026-09-01T09:45:00Z') },
      { startAt: d('2026-09-01T13:00:00Z'), endAt: d('2026-09-01T14:00:00Z') },
    ];
    const window = { startAt: d('2026-09-01T09:00:00Z'), endAt: d('2026-09-01T10:00:00Z') };
    expect(subtractInterval(blocks, window)).toEqual([
      { startAt: d('2026-09-01T06:00:00Z'), endAt: d('2026-09-01T07:00:00Z') },
      { startAt: d('2026-09-01T13:00:00Z'), endAt: d('2026-09-01T14:00:00Z') },
    ]);
  });
});
