import { describe, it, expect } from 'vitest';
import { DASHBOARD_YOUR_MOVE_CARD_KINDS, DASHBOARD_YOUR_MOVE_CHIPS } from '@balo/analytics/events';
import {
  ASSERT_YOUR_MOVE_CONTEXT_KEYS_COMPLETE,
  ASSERT_YOUR_MOVE_KEYS_COMPLETE,
  YOUR_MOVE_CARD_VIEW_KEYS,
  YOUR_MOVE_CONTEXT_KEYS,
  YOUR_MOVE_KIND_META,
} from './your-move-view-types';

const MONEY = /budget|price|amount|rate|cents|fee|balance|currency/i;

describe('YourMoveCardView key set', () => {
  it('is exactly the eleven card fields', () => {
    expect([...YOUR_MOVE_CARD_VIEW_KEYS].sort((a, b) => a.localeCompare(b))).toEqual(
      [
        'actionLabel',
        'counterparty',
        'context',
        'deadline',
        'fact',
        'factTone',
        'href',
        'id',
        'kind',
        'title',
        'waitingSince',
      ].sort((a, b) => a.localeCompare(b))
    );
    expect(ASSERT_YOUR_MOVE_KEYS_COMPLETE).toBe(true);
  });

  it('holds no money-shaped key on the card or any context variant', () => {
    for (const key of [...YOUR_MOVE_CARD_VIEW_KEYS, ...YOUR_MOVE_CONTEXT_KEYS]) {
      expect(key).not.toMatch(MONEY);
    }
    expect(ASSERT_YOUR_MOVE_CONTEXT_KEYS_COMPLETE).toBe(true);
  });
});

describe('YOUR_MOVE_KIND_META', () => {
  it('covers every card kind exactly once', () => {
    expect(Object.keys(YOUR_MOVE_KIND_META).sort((a, b) => a.localeCompare(b))).toEqual(
      [...DASHBOARD_YOUR_MOVE_CARD_KINDS].sort((a, b) => a.localeCompare(b))
    );
  });

  it('files every kind under a real filter chip', () => {
    for (const meta of Object.values(YOUR_MOVE_KIND_META)) {
      expect(DASHBOARD_YOUR_MOVE_CHIPS).toContain(meta.chip);
    }
  });

  it('puts only the calendar blocker in tier 0', () => {
    const tier0 = Object.entries(YOUR_MOVE_KIND_META).filter(([, m]) => m.tier === 0);
    expect(tier0.map(([k]) => k)).toEqual(['calendar_reconnect']);
  });
});
