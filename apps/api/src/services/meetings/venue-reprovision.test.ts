import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NonTargetLiveVenue, ScheduledVenueTarget } from '@balo/db';

const { mockWarn, mockInfo } = vi.hoisted(() => ({ mockWarn: vi.fn(), mockInfo: vi.fn() }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mockInfo, warn: mockWarn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({ meetingsRepository: {} }));

import { MISSED_CALL_TERMINATION_MS } from '@balo/shared/meetings';
import {
  DEFAULT_LIMIT,
  classifyNonTargets,
  describeDatabaseHost,
  joinUrlPrefixForDomain,
  runVenueReprovision,
} from './venue-reprovision.js';

const NOW = new Date('2026-09-01T09:00:00.000Z');
const FUTURE = new Date('2026-09-02T09:00:00.000Z');
const HOUR_MS = 3_600_000;
const CUTOFF_MS = NOW.getTime() - MISSED_CALL_TERMINATION_MS;

function target(meetingId: string): ScheduledVenueTarget {
  return { meetingId, scheduledStart: FUTURE };
}

/** A non-target row; `end` defaults to one hour after `start`. */
function row(
  meetingId: string,
  status: NonTargetLiveVenue['status'],
  startMs: number,
  endMs: number = startMs + HOUR_MS
): NonTargetLiveVenue {
  return { meetingId, status, scheduledStart: new Date(startMs), scheduledEnd: new Date(endMs) };
}

describe('joinUrlPrefixForDomain', () => {
  it.each([
    ['getbalo', 'https://getbalo.daily.co/'],
    ['getbalo.daily.co', 'https://getbalo.daily.co/'],
    ['balo-staging-2', 'https://balo-staging-2.daily.co/'],
  ])('normalises %s', (domain, expected) => {
    expect(joinUrlPrefixForDomain(domain)).toBe(expected);
  });

  it.each([
    'evil.co',
    'getbalo.daily.co.attacker',
    '',
    '.daily.co',
    'Get_Balo',
    'a/b',
    'a.b.daily.co',
  ])('rejects %j', (domain) => {
    expect(() => joinUrlPrefixForDomain(domain)).toThrow();
  });
});

describe('describeDatabaseHost', () => {
  it('prints the pooler host and the project ref from the username, never the password', () => {
    const printed = describeDatabaseHost(
      'postgresql://postgres.abcdefghij:s3cr3t@aws-0-ap.pooler.supabase.com:5432/postgres?sslmode=require'
    );
    expect(printed).toBe('aws-0-ap.pooler.supabase.com:5432 (project ref: abcdefghij)');
    expect(printed).not.toContain('s3cr3t');
    expect(printed).not.toContain('postgres.abcdefghij');
  });

  it('prints the project ref from a direct db.<ref>.supabase.co host', () => {
    const printed = describeDatabaseHost(
      'postgresql://postgres:s3cr3t@db.abcdefghij.supabase.co:5432/postgres'
    );
    expect(printed).toBe('db.abcdefghij.supabase.co:5432 (project ref: abcdefghij)');
    expect(printed).not.toContain('s3cr3t');
  });

  it('tells two projects behind the same pooler host apart', () => {
    const first = describeDatabaseHost(
      'postgres://postgres.aaaa:p@aws-0-ap.pooler.supabase.com/db'
    );
    const second = describeDatabaseHost(
      'postgres://postgres.bbbb:p@aws-0-ap.pooler.supabase.com/db'
    );
    expect(first).not.toBe(second);
  });

  it('prints n/a for a non-Supabase url, host only', () => {
    expect(describeDatabaseHost('postgres://u:s3cr3t@db.internal/app')).toBe(
      'db.internal (project ref: n/a)'
    );
  });

  it.each([
    [
      'a pooler username without the postgres. prefix',
      'postgres://admin:p@aws-0-ap.pooler.supabase.com/db',
    ],
    [
      'a pooler username with a non-alphanumeric ref',
      'postgres://postgres.AB_cd:p@aws-0-ap.pooler.supabase.com/db',
    ],
    [
      'a pooler username with an empty ref',
      'postgres://postgres.:p@aws-0-ap.pooler.supabase.com/db',
    ],
    ['a direct host with an uppercase ref', 'postgres://postgres:p@db.ABC.supabase.co/db'],
    ['a direct host with a nested label', 'postgres://postgres:p@db.a.b.supabase.co/db'],
  ])('prints n/a and never echoes the username for %s', (_label, url) => {
    const printed = describeDatabaseHost(url);
    expect(printed).toContain('(project ref: n/a)');
    expect(printed).not.toContain('AB_cd');
    expect(printed).not.toContain('admin');
  });

  it('prints a placeholder, never the value, when the url does not parse', () => {
    expect(describeDatabaseHost('not a url with s3cr3t')).toBe('[unparseable DATABASE_URL]');
  });
});

describe('classifyNonTargets', () => {
  it('a scheduled meeting that started inside the missed-call window is a blocker', () => {
    const inside = row('a', 'scheduled', CUTOFF_MS + 1);
    const justStarted = row('b', 'scheduled', NOW.getTime());

    const result = classifyNonTargets([inside, justStarted], NOW);

    expect(result.blockers).toEqual([inside, justStarted]);
    expect(result.stranded).toEqual([]);
  });

  it('a scheduled meeting that started at or before the cutoff is stranded', () => {
    const atCutoff = row('a', 'scheduled', CUTOFF_MS);
    const old = row('b', 'scheduled', NOW.getTime() - 30 * 24 * HOUR_MS);

    const result = classifyNonTargets([atCutoff, old], NOW);

    expect(result.stranded).toEqual([atCutoff, old]);
    expect(result.blockers).toEqual([]);
  });

  it.each(['waiting_for_participants', 'in_progress'] as const)(
    'a %s meeting still inside its scheduled window is a blocker, even if it started long ago',
    (status) => {
      const running = row('a', status, NOW.getTime() - 2 * HOUR_MS, NOW.getTime() + HOUR_MS);

      const result = classifyNonTargets([running], NOW);

      expect(result.blockers).toEqual([running]);
      expect(result.stranded).toEqual([]);
    }
  );

  it.each(['waiting_for_participants', 'in_progress'] as const)(
    'a %s meeting whose window ended at or before the cutoff is stranded',
    (status) => {
      const atCutoff = row('a', status, CUTOFF_MS - HOUR_MS, CUTOFF_MS);
      const old = row('b', status, NOW.getTime() - 48 * HOUR_MS);

      const result = classifyNonTargets([atCutoff, old], NOW);

      expect(result.stranded).toEqual([atCutoff, old]);
      expect(result.blockers).toEqual([]);
    }
  );

  it('a live-status meeting that ended just after the cutoff is still a blocker', () => {
    const justInside = row('a', 'in_progress', CUTOFF_MS - HOUR_MS, CUTOFF_MS + 1);

    expect(classifyNonTargets([justInside], NOW).blockers).toEqual([justInside]);
  });

  it('honours an injected missed-call window', () => {
    const startedFiveMinutesAgo = row('a', 'scheduled', NOW.getTime() - 5 * 60_000);

    expect(classifyNonTargets([startedFiveMinutesAgo], NOW, 3 * 60_000).stranded).toEqual([
      startedFiveMinutesAgo,
    ]);
    expect(classifyNonTargets([startedFiveMinutesAgo], NOW, 30 * 60_000).blockers).toEqual([
      startedFiveMinutesAgo,
    ]);
  });
});

describe('runVenueReprovision', () => {
  const listScheduledVenueTargetsOnDomain = vi.fn();
  const listNonTargetLiveVenuesOnDomain = vi.fn();
  const clearScheduledVenuesOnDomain = vi.fn();
  const deps = {
    repo: {
      listScheduledVenueTargetsOnDomain,
      listNonTargetLiveVenuesOnDomain,
      clearScheduledVenuesOnDomain,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    listScheduledVenueTargetsOnDomain.mockResolvedValue([]);
    listNonTargetLiveVenuesOnDomain.mockResolvedValue([]);
  });

  it('dry run reads both sets with the prefix, now and limit, reports and never clears', async () => {
    listScheduledVenueTargetsOnDomain.mockResolvedValue([target('a')]);

    const report = await runVenueReprovision(
      { fromDomain: 'getbalo', apply: false, now: NOW },
      deps
    );

    expect(listScheduledVenueTargetsOnDomain).toHaveBeenCalledWith({
      joinUrlPrefix: 'https://getbalo.daily.co/',
      scheduledStartAfter: NOW,
      limit: DEFAULT_LIMIT,
    });
    expect(listNonTargetLiveVenuesOnDomain).toHaveBeenCalledWith({
      joinUrlPrefix: 'https://getbalo.daily.co/',
      scheduledStartAtOrBefore: NOW,
      limit: DEFAULT_LIMIT,
    });
    expect(clearScheduledVenuesOnDomain).not.toHaveBeenCalled();
    expect(report.targets.map((t) => t.meetingId)).toEqual(['a']);
    expect(report.cleared).toBeNull();
    expect(report.skipped).toEqual([]);
    expect(report.targetsBatchFilled).toBe(false);
    expect(report.nonTargetsBatchFilled).toBe(false);
  });

  it('reports blockers and stranded separately', async () => {
    const blocker = row('b', 'in_progress', NOW.getTime() - HOUR_MS, NOW.getTime() + HOUR_MS);
    const stranded = row('s', 'scheduled', NOW.getTime() - 24 * HOUR_MS);
    listNonTargetLiveVenuesOnDomain.mockResolvedValue([blocker, stranded]);

    const report = await runVenueReprovision(
      { fromDomain: 'getbalo', apply: false, now: NOW },
      deps
    );

    expect(report.blockers).toEqual([blocker]);
    expect(report.stranded).toEqual([stranded]);
    expect(mockWarn).toHaveBeenCalledWith(
      { fromDomain: 'getbalo', stranded: 1 },
      'stranded meetings remain on the old Daily domain; the meeting.stranded alert owns them'
    );
  });

  it('blockers ahead of the targets never starve the target batch', async () => {
    const blockers = ['b1', 'b2', 'b3'].map((id) =>
      row(id, 'in_progress', NOW.getTime() - HOUR_MS, NOW.getTime() + HOUR_MS)
    );
    listNonTargetLiveVenuesOnDomain.mockResolvedValue(blockers);
    listScheduledVenueTargetsOnDomain.mockResolvedValue([target('t1')]);

    const report = await runVenueReprovision(
      { fromDomain: 'getbalo', apply: false, now: NOW, limit: 3 },
      deps
    );

    expect(listScheduledVenueTargetsOnDomain).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 3 })
    );
    expect(report.targets.map((t) => t.meetingId)).toEqual(['t1']);
    expect(report.blockers).toHaveLength(3);
  });

  it('apply clears the target ids with the prefix and now, and reports skipped targets', async () => {
    listScheduledVenueTargetsOnDomain.mockResolvedValue([target('a'), target('b')]);
    listNonTargetLiveVenuesOnDomain.mockResolvedValue([
      row('c', 'in_progress', NOW.getTime() - HOUR_MS, NOW.getTime() + HOUR_MS),
    ]);
    clearScheduledVenuesOnDomain.mockResolvedValue(['a']);

    const report = await runVenueReprovision(
      { fromDomain: 'getbalo.daily.co', apply: true, now: NOW },
      deps
    );

    expect(clearScheduledVenuesOnDomain).toHaveBeenCalledWith({
      meetingIds: ['a', 'b'],
      joinUrlPrefix: 'https://getbalo.daily.co/',
      scheduledStartAfter: NOW,
    });
    expect(report.cleared).toEqual(['a']);
    expect(report.skipped).toEqual(['b']);
    expect(report.blockers.map((b) => b.meetingId)).toEqual(['c']);
    expect(mockInfo).toHaveBeenCalledWith(
      { fromDomain: 'getbalo.daily.co', cleared: 1, skipped: 1, blockers: 1 },
      'meeting venues cleared for re-provision'
    );
    expect(mockWarn).toHaveBeenCalledWith(
      { fromDomain: 'getbalo.daily.co', blockers: 1 },
      'meetings still on the old Daily domain were left in place'
    );
  });

  it('apply with no blockers does not warn', async () => {
    listScheduledVenueTargetsOnDomain.mockResolvedValue([target('a')]);
    clearScheduledVenuesOnDomain.mockResolvedValue(['a']);

    await runVenueReprovision({ fromDomain: 'getbalo', apply: true, now: NOW }, deps);

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('apply with only stranded meetings clears and warns about the stranded, not as blockers', async () => {
    listScheduledVenueTargetsOnDomain.mockResolvedValue([target('a')]);
    listNonTargetLiveVenuesOnDomain.mockResolvedValue([
      row('s', 'in_progress', NOW.getTime() - 48 * HOUR_MS),
    ]);
    clearScheduledVenuesOnDomain.mockResolvedValue(['a']);

    const report = await runVenueReprovision(
      { fromDomain: 'getbalo', apply: true, now: NOW },
      deps
    );

    expect(report.blockers).toEqual([]);
    expect(report.stranded.map((s) => s.meetingId)).toEqual(['s']);
    expect(mockWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      'meetings still on the old Daily domain were left in place'
    );
  });

  it('flags targetsBatchFilled and warns when the target read returns exactly the limit', async () => {
    listScheduledVenueTargetsOnDomain.mockResolvedValue([target('a'), target('b')]);

    const report = await runVenueReprovision(
      { fromDomain: 'getbalo', apply: false, now: NOW, limit: 2 },
      deps
    );

    expect(report.targetsBatchFilled).toBe(true);
    expect(report.nonTargetsBatchFilled).toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(
      { fromDomain: 'getbalo', limit: 2 },
      'venue reprovision target read hit its limit; run again'
    );
  });

  it('flags nonTargetsBatchFilled and warns when the non-target read returns exactly the limit', async () => {
    listNonTargetLiveVenuesOnDomain.mockResolvedValue([
      row('a', 'in_progress', NOW.getTime() - HOUR_MS, NOW.getTime() + HOUR_MS),
      row('b', 'in_progress', NOW.getTime() - HOUR_MS, NOW.getTime() + HOUR_MS),
    ]);

    const report = await runVenueReprovision(
      { fromDomain: 'getbalo', apply: false, now: NOW, limit: 2 },
      deps
    );

    expect(report.nonTargetsBatchFilled).toBe(true);
    expect(report.targetsBatchFilled).toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(
      { fromDomain: 'getbalo', limit: 2 },
      'venue reprovision blocker read hit its limit; the oldest stranded meetings may be unreported'
    );
  });

  it('rejects an invalid domain before reading', async () => {
    await expect(
      runVenueReprovision({ fromDomain: 'evil.co', apply: true, now: NOW }, deps)
    ).rejects.toThrow();
    expect(listScheduledVenueTargetsOnDomain).not.toHaveBeenCalled();
    expect(listNonTargetLiveVenuesOnDomain).not.toHaveBeenCalled();
  });
});
