import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveVenueOnDomain } from '@balo/db';

const { mockWarn, mockInfo } = vi.hoisted(() => ({ mockWarn: vi.fn(), mockInfo: vi.fn() }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: mockInfo, warn: mockWarn, error: vi.fn() }),
}));
vi.mock('@balo/db', () => ({ meetingsRepository: {} }));

import {
  DEFAULT_LIMIT,
  describeDatabaseHost,
  joinUrlPrefixForDomain,
  partitionReprovisionCandidates,
  runVenueReprovision,
} from './venue-reprovision.js';

const NOW = new Date('2026-09-01T09:00:00.000Z');
const FUTURE = new Date('2026-09-02T09:00:00.000Z');
const PAST = new Date('2026-09-01T08:00:00.000Z');

function row(
  meetingId: string,
  status: LiveVenueOnDomain['status'],
  scheduledStart: Date
): LiveVenueOnDomain {
  return { meetingId, status, scheduledStart };
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
  it('returns the host and port only, never credentials, path or query', () => {
    const printed = describeDatabaseHost(
      'postgresql://postgres.abc:s3cr3t@aws-0-ap.pooler.supabase.com:5432/postgres?sslmode=require'
    );
    expect(printed).toBe('aws-0-ap.pooler.supabase.com:5432');
    expect(printed).not.toContain('s3cr3t');
    expect(printed).not.toContain('postgres.abc');
  });

  it('returns a host without a port as is', () => {
    expect(describeDatabaseHost('postgres://u:p@db.internal/app')).toBe('db.internal');
  });

  it('prints a placeholder, never the value, when the url does not parse', () => {
    expect(describeDatabaseHost('not a url with s3cr3t')).toBe('[unparseable DATABASE_URL]');
  });
});

describe('partitionReprovisionCandidates', () => {
  it('targets only future scheduled meetings; everything else is a blocker', () => {
    const future = row('a', 'scheduled', FUTURE);
    const pastScheduled = row('b', 'scheduled', PAST);
    const startsNow = row('c', 'scheduled', NOW);
    const waiting = row('d', 'waiting_for_participants', FUTURE);
    const inProgress = row('e', 'in_progress', PAST);

    const result = partitionReprovisionCandidates(
      [future, pastScheduled, startsNow, waiting, inProgress],
      NOW
    );

    expect(result.targets).toEqual([future]);
    expect(result.blockers).toEqual([pastScheduled, startsNow, waiting, inProgress]);
  });
});

describe('runVenueReprovision', () => {
  const listLiveVenuesOnDomain = vi.fn();
  const clearScheduledVenuesOnDomain = vi.fn();
  const deps = { repo: { listLiveVenuesOnDomain, clearScheduledVenuesOnDomain } };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dry run reads, reports and never clears', async () => {
    listLiveVenuesOnDomain.mockResolvedValue([row('a', 'scheduled', FUTURE)]);

    const report = await runVenueReprovision(
      { fromDomain: 'getbalo', apply: false, now: NOW },
      deps
    );

    expect(listLiveVenuesOnDomain).toHaveBeenCalledWith({
      joinUrlPrefix: 'https://getbalo.daily.co/',
      limit: DEFAULT_LIMIT,
    });
    expect(clearScheduledVenuesOnDomain).not.toHaveBeenCalled();
    expect(report.targets.map((t) => t.meetingId)).toEqual(['a']);
    expect(report.cleared).toBeNull();
    expect(report.skipped).toEqual([]);
    expect(report.batchFilled).toBe(false);
  });

  it('apply clears the target ids with the prefix and now, and reports skipped targets', async () => {
    listLiveVenuesOnDomain.mockResolvedValue([
      row('a', 'scheduled', FUTURE),
      row('b', 'scheduled', FUTURE),
      row('c', 'in_progress', PAST),
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
    listLiveVenuesOnDomain.mockResolvedValue([row('a', 'scheduled', FUTURE)]);
    clearScheduledVenuesOnDomain.mockResolvedValue(['a']);

    await runVenueReprovision({ fromDomain: 'getbalo', apply: true, now: NOW }, deps);

    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('flags batchFilled and warns when the read returns exactly the limit', async () => {
    listLiveVenuesOnDomain.mockResolvedValue([
      row('a', 'scheduled', FUTURE),
      row('b', 'scheduled', FUTURE),
    ]);

    const report = await runVenueReprovision(
      { fromDomain: 'getbalo', apply: false, now: NOW, limit: 2 },
      deps
    );

    expect(report.batchFilled).toBe(true);
    expect(mockWarn).toHaveBeenCalledWith(
      { fromDomain: 'getbalo', limit: 2 },
      'venue reprovision read hit its limit; run again'
    );
  });

  it('rejects an invalid domain before reading', async () => {
    await expect(
      runVenueReprovision({ fromDomain: 'evil.co', apply: true, now: NOW }, deps)
    ).rejects.toThrow();
    expect(listLiveVenuesOnDomain).not.toHaveBeenCalled();
  });
});
