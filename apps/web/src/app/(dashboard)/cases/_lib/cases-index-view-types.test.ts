import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveRouteDir } from '@/invariants/_source-scan';
import {
  ASSERT_CASES_INDEX_CARD_KEYS_COMPLETE,
  ASSERT_CASES_INDEX_RESOLVED_KEYS_COMPLETE,
  CASES_INDEX_CARD_VIEW_KEYS,
  CASES_INDEX_RESOLVED_ROW_VIEW_KEYS,
  CASE_TRAIL_MARKS,
} from './cases-index-view-types';

/**
 * BAL-567 — the view model's SHAPE, pinned.
 *
 * ⚠ THE TWO `ASSERT_…_COMPLETE` CONSTANTS ARE REFERENCED HERE ON PURPOSE. They are `satisfies`
 * witnesses that fail `tsc` when a key is added to an interface but not to its tuple; referencing
 * them keeps them from rotting into "declared but unused" and being deleted as dead code.
 */

describe('the card view’s key tuple', () => {
  it('has no missing key (the compile-time witness holds)', () => {
    expect(ASSERT_CASES_INDEX_CARD_KEYS_COMPLETE).toBe(true);
    expect(ASSERT_CASES_INDEX_RESOLVED_KEYS_COMPLETE).toBe(true);
  });

  it('is EXACTLY these keys, in this order — a length assertion pairs every set assertion', () => {
    expect([...CASES_INDEX_CARD_VIEW_KEYS]).toEqual([
      'engagementId',
      'href',
      'title',
      'cardState',
      'counterpartyName',
      'counterpartyOrgLabel',
      'counterpartyAvatarUrl',
      'counterpartyInitials',
      'productTags',
      'trail',
      'heldCount',
      'actionItemsForYou',
      'unread',
      'openedAtIso',
      'nextBookingStartIso',
      'nextBookingEndIso',
      'nextBookingStatus',
      'lastCallAtIso',
      'proposalOptionCount',
      'actorLabel',
      'bookAgainHref',
      'joinPath',
    ]);
    expect(CASES_INDEX_CARD_VIEW_KEYS).toHaveLength(22);
  });

  it('pins the resolved row’s keys exactly too', () => {
    expect([...CASES_INDEX_RESOLVED_ROW_VIEW_KEYS]).toEqual([
      'engagementId',
      'href',
      'title',
      'counterpartyName',
      'counterpartyOrgLabel',
      'closedAtIso',
      'closeReason',
      'heldCount',
      'bookAgainHref',
    ]);
    expect(CASES_INDEX_RESOLVED_ROW_VIEW_KEYS).toHaveLength(9);
  });

  it('pins the five trail marks, in order', () => {
    expect([...CASE_TRAIL_MARKS]).toEqual(['held', 'booked', 'cancelled', 'missed', 'unrecorded']);
    expect(CASE_TRAIL_MARKS).toHaveLength(5);
  });
});

/**
 * ⚠⚠ THE MODULE MUST STAY VALUE-IMPORT-FREE. A runtime import here reaches every client bundle
 * that imports the view model, and a `@balo/db` one breaks `next build` outright with "can't
 * resolve 'tls'" (memory `reference_balo_db_client_bundle_footgun`). A type-only import is
 * ERASED; a value one is not, and nothing else in the build would say so.
 */
describe('the view-model module is client-safe by construction', () => {
  const VIEW_TYPES_FILE = resolveRouteDir([
    'src/app/(dashboard)/cases/_lib/cases-index-view-types.ts',
    'apps/web/src/app/(dashboard)/cases/_lib/cases-index-view-types.ts',
  ]);

  it('found the file (guards a vacuous pass)', () => {
    expect(VIEW_TYPES_FILE).not.toBe('');
  });

  it('imports nothing but TYPES', () => {
    const source = readFileSync(VIEW_TYPES_FILE, 'utf8');
    const importLines = source.split('\n').filter((line) => line.trimStart().startsWith('import '));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).toContain('import type');
    }
  });
});
