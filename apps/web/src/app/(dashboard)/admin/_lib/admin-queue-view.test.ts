import { describe, it, expect } from 'vitest';
import type { AdminAlert, AdminAlertKindCount, AdminSweepTick } from '@balo/db';
import type { AdminAlertDetail } from '@balo/shared/admin-alerts';
import {
  buildAdminQueueRow,
  buildAdminQueueView,
  formatAdminAlertAge,
  adminAlertAgeBucket,
  adminAlertKindsForGroupFilter,
  parseAdminAlertGroupFilter,
  nextAdminQueueCursor,
} from './admin-queue-view';

const NOW = new Date('2026-09-08T12:00:00.000Z');

function detail(overrides: Partial<AdminAlertDetail> = {}): AdminAlertDetail {
  return {
    title: 'An application is waiting on review',
    entityLabel: 'Priya Nair @ CloudPeak',
    evidence: 'Submitted 3d ago, no reviewer assigned.',
    facts: [['Submitted', '3d ago']],
    ...overrides,
  };
}

function alert(overrides: Partial<AdminAlert> = {}): AdminAlert {
  return {
    id: 'alert-1',
    kind: 'expert.application_pending',
    entityType: 'expert',
    entityId: 'expert-1',
    detail: detail(),
    firstSeenAt: new Date('2026-09-05T12:00:00.000Z'), // 3 days before NOW
    lastSeenAt: new Date('2026-09-05T12:00:00.000Z'),
    occurrences: 1,
    resolvedAt: null,
    resolvedByUserId: null,
    resolutionNote: null,
    createdAt: new Date('2026-09-05T12:00:00.000Z'),
    updatedAt: new Date('2026-09-05T12:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('formatAdminAlertAge', () => {
  it('renders minutes under an hour', () => {
    expect(formatAdminAlertAge(5)).toBe('5m');
    expect(formatAdminAlertAge(59)).toBe('59m');
  });

  it('renders hours under a day', () => {
    expect(formatAdminAlertAge(60)).toBe('1h');
    expect(formatAdminAlertAge(90)).toBe('2h');
  });

  it('renders days at or beyond a day', () => {
    expect(formatAdminAlertAge(1440)).toBe('1d');
    expect(formatAdminAlertAge(4320)).toBe('3d');
  });
});

describe('adminAlertAgeBucket (BAL-548 analytics)', () => {
  it('under_1d for anything short of a day', () => {
    expect(adminAlertAgeBucket(0)).toBe('under_1d');
    expect(adminAlertAgeBucket(0.9)).toBe('under_1d');
  });

  it('1_3d from exactly 1 day up to (not including) 3 days', () => {
    expect(adminAlertAgeBucket(1)).toBe('1_3d');
    expect(adminAlertAgeBucket(2.9)).toBe('1_3d');
  });

  it('3_7d from exactly 3 days up to (not including) 7 days', () => {
    expect(adminAlertAgeBucket(3)).toBe('3_7d');
    expect(adminAlertAgeBucket(6.9)).toBe('3_7d');
  });

  it('over_7d at or beyond 7 days', () => {
    expect(adminAlertAgeBucket(7)).toBe('over_7d');
    expect(adminAlertAgeBucket(30)).toBe('over_7d');
  });
});

describe('parseAdminAlertGroupFilter', () => {
  it('resolves a known group', () => {
    expect(parseAdminAlertGroupFilter('money')).toBe('money');
  });

  it('resolves undefined, an unknown value, and a prototype-chain name to null (= all)', () => {
    expect(parseAdminAlertGroupFilter(undefined)).toBeNull();
    expect(parseAdminAlertGroupFilter('bogus')).toBeNull();
    expect(parseAdminAlertGroupFilter('__proto__')).toBeNull();
    expect(parseAdminAlertGroupFilter('constructor')).toBeNull();
  });
});

describe('adminAlertKindsForGroupFilter', () => {
  it('returns every money-group kind AND its storm derivative', () => {
    const kinds = adminAlertKindsForGroupFilter('money');
    expect(kinds).toContain('receivable.open');
    expect(kinds).toContain('receivable.open.storm');
    expect(kinds).toContain('topup.unresolved_pi');
    expect(kinds).toContain('topup.unresolved_pi.storm');
    expect(kinds).not.toContain('recording.failed');
  });

  it('never includes a platform-group kind under any tile group', () => {
    const allTileKinds = [
      ...adminAlertKindsForGroupFilter('marketplace'),
      ...adminAlertKindsForGroupFilter('money'),
      ...adminAlertKindsForGroupFilter('capture'),
      ...adminAlertKindsForGroupFilter('meetings'),
    ];
    expect(allTileKinds).not.toContain('sweep.failed');
  });
});

describe('buildAdminQueueRow', () => {
  it('resolves a finder kind as self-closing, not note-closeable', () => {
    const row = buildAdminQueueRow(alert(), { canSeeFees: true, now: NOW });
    expect(row.group).toBe('marketplace');
    expect(row.selfCloses).toBe(true);
    expect(row.noteCloseable).toBe(false);
    expect(row.closes).toContain('Closes itself');
  });

  it('resolves an event-driven (no-finder) kind as note-closeable, not self-closing', () => {
    const row = buildAdminQueueRow(alert({ kind: 'session.open_refused', entityType: 'meeting' }), {
      canSeeFees: true,
      now: NOW,
    });
    expect(row.selfCloses).toBe(false);
    expect(row.noteCloseable).toBe(true);
  });

  it('resolves a storm kind as self-closing and NOT note-closeable', () => {
    const row = buildAdminQueueRow(
      alert({ kind: 'expert.application_pending.storm', entityType: 'sweep' }),
      { canSeeFees: true, now: NOW }
    );
    expect(row.selfCloses).toBe(true);
    expect(row.noteCloseable).toBe(false);
  });

  it('falls back to a neutral platform row for an unresolvable kind — never dropped', () => {
    const row = buildAdminQueueRow(alert({ kind: 'no.such.kind' }), {
      canSeeFees: true,
      now: NOW,
    });
    expect(row.group).toBe('platform');
    expect(row.closes).toBe('Closes with a note');
    expect(row.target).toEqual({ label: 'the queue', href: '/admin' });
  });

  it('splits entityHead off the "@" and "·" boundaries', () => {
    const row = buildAdminQueueRow(alert(), { canSeeFees: true, now: NOW });
    expect(row.entityHead).toBe('Priya Nair');
  });

  it('marks age emphasised at or beyond the emphasis threshold (3 days)', () => {
    const justUnder = buildAdminQueueRow(
      alert({ firstSeenAt: new Date('2026-09-05T12:00:00.001Z') }),
      { canSeeFees: true, now: NOW }
    );
    expect(justUnder.ageEmphasised).toBe(false);

    const atThreshold = buildAdminQueueRow(
      alert({ firstSeenAt: new Date('2026-09-05T12:00:00.000Z') }),
      { canSeeFees: true, now: NOW }
    );
    expect(atThreshold.ageEmphasised).toBe(true);
  });

  it('has no money block when the kind carries none', () => {
    const row = buildAdminQueueRow(alert(), { canSeeFees: true, now: NOW });
    expect(row.money).toBeNull();
    expect(row.moneyConcealed).toBe(false);
  });

  it('🚩 strips expert/margin/markup for a viewer without MANAGE_PLATFORM_FEES, keeps client', () => {
    const row = buildAdminQueueRow(
      alert({
        kind: 'receivable.open',
        detail: detail({
          money: { client: 'A$500.00', expert: 'A$400.00', margin: 'A$100.00', markup: '25%' },
        }),
      }),
      { canSeeFees: false, now: NOW }
    );
    expect(row.money).toEqual({
      client: 'A$500.00',
      expert: null,
      margin: null,
      markup: null,
      extra: undefined,
    });
    expect(row.moneyConcealed).toBe(true);
    // The concealed fields must not merely be hidden downstream — they must not be present.
    expect(JSON.stringify(row)).not.toContain('A$400.00');
    expect(JSON.stringify(row)).not.toContain('A$100.00');
  });

  it('keeps expert/margin/markup for a viewer WITH MANAGE_PLATFORM_FEES', () => {
    const row = buildAdminQueueRow(
      alert({
        kind: 'receivable.open',
        detail: detail({
          money: { client: 'A$500.00', expert: 'A$400.00', margin: 'A$100.00', markup: '25%' },
        }),
      }),
      { canSeeFees: true, now: NOW }
    );
    expect(row.money).toEqual({
      client: 'A$500.00',
      expert: 'A$400.00',
      margin: 'A$100.00',
      markup: '25%',
      extra: undefined,
    });
    expect(row.moneyConcealed).toBe(false);
  });
});

describe('nextAdminQueueCursor', () => {
  it('returns null when there is no more', () => {
    const rows = [buildAdminQueueRow(alert(), { canSeeFees: true, now: NOW })];
    expect(nextAdminQueueCursor(rows, false)).toBeNull();
  });

  it('returns null for an empty row set even when hasMore is true (defensive)', () => {
    expect(nextAdminQueueCursor([], true)).toBeNull();
  });

  it('returns the last row cursor when there is more', () => {
    const rows = [
      buildAdminQueueRow(alert({ id: 'a' }), { canSeeFees: true, now: NOW }),
      buildAdminQueueRow(alert({ id: 'b' }), { canSeeFees: true, now: NOW }),
    ];
    expect(nextAdminQueueCursor(rows, true)).toEqual({
      firstSeenAtIso: '2026-09-05T12:00:00.000Z',
      id: 'b',
    });
  });
});

function count(kind: string, count: number, oldestFirstSeenAt: Date): AdminAlertKindCount {
  return { kind, count, oldestFirstSeenAt };
}

describe('buildAdminQueueView', () => {
  it('builds the header line from counts, not from rows.length', () => {
    const view = buildAdminQueueView({
      counts: [
        count('expert.application_pending', 3, new Date('2026-09-05T12:00:00.000Z')),
        count('session.open_refused', 2, new Date('2026-09-06T12:00:00.000Z')),
      ],
      page: { alerts: [alert()], hasMore: false },
      globalOldest: null,
      ticks: [],
      canSeeFees: true,
      group: null,
      now: NOW,
    });
    expect(view.totalOpenCount).toBe(5);
    expect(view.headerLine).toBe('5 open · 2 close with a note · oldest waiting 3d');
    // BAL-548 analytics — `oldestAgeDays` is a NUMBER (for `admin_queue_viewed`'s
    // `oldest_age_days`), independent of `oldest.age`'s formatted string.
    expect(view.oldestAgeDays).toBeCloseTo(3, 1);
  });

  it('renders "0 open" and isEmpty when nothing is open anywhere', () => {
    const view = buildAdminQueueView({
      counts: [],
      page: { alerts: [], hasMore: false },
      globalOldest: null,
      ticks: [],
      canSeeFees: true,
      group: null,
      now: NOW,
    });
    expect(view.headerLine).toBe('0 open');
    expect(view.isEmpty).toBe(true);
    expect(view.oldest).toBeNull();
    expect(view.oldestAgeDays).toBe(0);
  });

  it('uses page.alerts[0] as the oldest when unfiltered', () => {
    const view = buildAdminQueueView({
      counts: [count('expert.application_pending', 1, new Date('2026-09-05T12:00:00.000Z'))],
      page: { alerts: [alert()], hasMore: false },
      globalOldest: null,
      ticks: [],
      canSeeFees: true,
      group: null,
      now: NOW,
    });
    expect(view.oldest?.entityHead).toBe('Priya Nair');
  });

  it('uses the SEPARATE globalOldest read when a group filter is active, not page.alerts[0]', () => {
    const view = buildAdminQueueView({
      counts: [count('receivable.open', 1, new Date('2026-08-01T00:00:00.000Z'))],
      page: {
        alerts: [alert({ kind: 'expert.application_pending', entityId: 'expert-2' })],
        hasMore: false,
      },
      globalOldest: alert({
        kind: 'receivable.open',
        entityId: 'company-9',
        detail: detail({ entityLabel: 'Northwind Industrial' }),
      }),
      ticks: [],
      canSeeFees: true,
      group: 'marketplace',
      now: NOW,
    });
    expect(view.oldest?.entityHead).toBe('Northwind Industrial');
  });

  it('folds storm-kind counts into the base kind group for tiles, and excludes the platform group', () => {
    const view = buildAdminQueueView({
      counts: [
        count('expert.application_pending.storm', 40, new Date('2026-09-01T00:00:00.000Z')),
        count('sweep.failed', 1, new Date('2026-09-01T00:00:00.000Z')),
      ],
      page: { alerts: [], hasMore: false },
      globalOldest: null,
      ticks: [],
      canSeeFees: true,
      group: null,
      now: NOW,
    });
    const marketplaceTile = view.tiles.find((t) => t.key === 'marketplace');
    expect(marketplaceTile?.count).toBe(40);
    expect(view.tiles.map((t) => t.key)).toEqual(['marketplace', 'money', 'capture', 'meetings']);
    // sweep.failed (platform group) is counted in the total but has no tile.
    expect(view.totalOpenCount).toBe(41);
  });

  it('reports isFilteredEmpty only when a filter is active and no rows matched', () => {
    const view = buildAdminQueueView({
      counts: [count('recording.failed', 2, new Date('2026-09-01T00:00:00.000Z'))],
      page: { alerts: [], hasMore: false },
      globalOldest: alert({ kind: 'recording.failed', entityType: 'recording' }),
      ticks: [],
      canSeeFees: true,
      group: 'marketplace',
      now: NOW,
    });
    expect(view.isFilteredEmpty).toBe(true);
    expect(view.isEmpty).toBe(false);
  });

  it('reports the freshest "swept Ns ago" summary, and a title enumerating all three cadences', () => {
    const ticks: AdminSweepTick[] = [
      {
        cadence: '1m',
        lastTickAt: new Date('2026-09-08T11:59:30.000Z'),
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        cadence: '5m',
        lastTickAt: new Date('2026-09-08T11:55:00.000Z'),
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const view = buildAdminQueueView({
      counts: [],
      page: { alerts: [], hasMore: false },
      globalOldest: null,
      ticks,
      canSeeFees: true,
      group: null,
      now: NOW,
    });
    expect(view.sweep.summary).toBe('swept 0m ago');
    expect(view.sweep.detail).toContain('1m ·');
    expect(view.sweep.detail).toContain('5m ·');
    expect(view.sweep.detail).toContain('15m ·');
  });

  it('reports "sweep hasn\'t run yet" when there are no ticks at all', () => {
    const view = buildAdminQueueView({
      counts: [],
      page: { alerts: [], hasMore: false },
      globalOldest: null,
      ticks: [],
      canSeeFees: true,
      group: null,
      now: NOW,
    });
    expect(view.sweep.summary).toBe("sweep hasn't run yet");
    expect(view.sweep.stale).toBe(false);
  });

  it('flags a stale cadence (older than 3x its own period) and names it', () => {
    const ticks: AdminSweepTick[] = [
      {
        cadence: '1m',
        lastTickAt: new Date('2026-09-08T11:55:00.000Z'), // 5 minutes ago, > 3×1m
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const view = buildAdminQueueView({
      counts: [],
      page: { alerts: [], hasMore: false },
      globalOldest: null,
      ticks,
      canSeeFees: true,
      group: null,
      now: NOW,
    });
    expect(view.sweep.stale).toBe(true);
    expect(view.sweep.staleLabel).toContain('sweep behind — 1m last ran');
  });

  it('sets nextCursor to null when the page has no more', () => {
    const view = buildAdminQueueView({
      counts: [count('expert.application_pending', 1, new Date('2026-09-05T12:00:00.000Z'))],
      page: { alerts: [alert()], hasMore: false },
      globalOldest: null,
      ticks: [],
      canSeeFees: true,
      group: null,
      now: NOW,
    });
    expect(view.nextCursor).toBeNull();
  });

  it('sets nextCursor to the last row cursor when the page has more', () => {
    const view = buildAdminQueueView({
      counts: [count('expert.application_pending', 2, new Date('2026-09-05T12:00:00.000Z'))],
      page: {
        alerts: [alert({ id: 'a' }), alert({ id: 'b' })],
        hasMore: true,
      },
      globalOldest: null,
      ticks: [],
      canSeeFees: true,
      group: null,
      now: NOW,
    });
    expect(view.nextCursor).toEqual({ firstSeenAtIso: '2026-09-05T12:00:00.000Z', id: 'b' });
  });
});
