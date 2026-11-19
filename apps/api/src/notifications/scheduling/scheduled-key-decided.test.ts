import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindByDedupeKey } = vi.hoisted(() => ({ mockFindByDedupeKey: vi.fn() }));

vi.mock('@balo/db', () => ({
  scheduledNotificationsRepository: { findByDedupeKey: mockFindByDedupeKey },
}));

import { isScheduledKeyDecided, scheduledKeyDecided } from './scheduled-key-decided.js';

type Row = Parameters<typeof scheduledKeyDecided>[0][number];

const REARMABLE = ['waiter_left', 'already_decided'];

function row(status: string, skipReason: string | null = null, id = 'row-0'): Row {
  return { id, status, skipReason } as Row;
}

describe('scheduledKeyDecided', () => {
  it('is false for a key with no history', () => {
    expect(scheduledKeyDecided([], REARMABLE)).toBe(false);
  });

  it.each(['published', 'claimed', 'failed'])('is true once a row is %s', (status) => {
    expect(scheduledKeyDecided([row(status)], REARMABLE)).toBe(true);
  });

  it.each(['pending', 'cancelled'])('is false for a %s row', (status) => {
    expect(scheduledKeyDecided([row(status)], REARMABLE)).toBe(false);
  });

  it('is false for a skip whose reason is re-armable', () => {
    expect(scheduledKeyDecided([row('skipped', 'waiter_left')], REARMABLE)).toBe(false);
    expect(scheduledKeyDecided([row('skipped', 'already_decided')], REARMABLE)).toBe(false);
  });

  it('is true for a skip whose reason is final, or missing', () => {
    expect(scheduledKeyDecided([row('skipped', 'no_number')], REARMABLE)).toBe(true);
    expect(scheduledKeyDecided([row('skipped', null)], REARMABLE)).toBe(true);
  });

  it('⚠ failedRearms: a failed row no longer decides, but published and claimed still do', () => {
    const options = { failedRearms: true };

    expect(scheduledKeyDecided([row('failed')], REARMABLE, undefined, options)).toBe(false);
    expect(scheduledKeyDecided([row('published')], REARMABLE, undefined, options)).toBe(true);
    expect(scheduledKeyDecided([row('claimed')], REARMABLE, undefined, options)).toBe(true);
    expect(scheduledKeyDecided([row('failed')], REARMABLE, undefined, {})).toBe(true);
  });

  it('failedRearms leaves a final skip final', () => {
    expect(
      scheduledKeyDecided([row('skipped', 'no_number')], REARMABLE, undefined, {
        failedRearms: true,
      })
    ).toBe(true);
  });

  it('reads the re-armable set it is given, not a fixed one', () => {
    expect(scheduledKeyDecided([row('skipped', 'no_number')], ['no_number'])).toBe(false);
    expect(scheduledKeyDecided([row('skipped', 'waiter_left')], [])).toBe(true);
  });

  it('ignores the asking row', () => {
    expect(scheduledKeyDecided([row('claimed', null, 'me')], REARMABLE, 'me')).toBe(false);
    expect(
      scheduledKeyDecided([row('claimed', null, 'me'), row('published')], REARMABLE, 'me')
    ).toBe(true);
  });

  it('is true when any one of several rows decided', () => {
    expect(
      scheduledKeyDecided(
        [row('pending'), row('skipped', 'waiter_left'), row('published')],
        REARMABLE
      )
    ).toBe(true);
  });
});

describe('isScheduledKeyDecided', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the key history and applies the same rule', async () => {
    mockFindByDedupeKey.mockResolvedValue([row('published')]);

    await expect(isScheduledKeyDecided('k', REARMABLE)).resolves.toBe(true);
    expect(mockFindByDedupeKey).toHaveBeenCalledWith('k');
  });

  it('passes the options through', async () => {
    mockFindByDedupeKey.mockResolvedValue([row('failed')]);

    await expect(
      isScheduledKeyDecided('k', REARMABLE, undefined, { failedRearms: true })
    ).resolves.toBe(false);
  });

  it('passes the asking row through', async () => {
    mockFindByDedupeKey.mockResolvedValue([row('claimed', null, 'me')]);

    await expect(isScheduledKeyDecided('k', REARMABLE, 'me')).resolves.toBe(false);
  });
});
