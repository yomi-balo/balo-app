import { describe, it, expect } from 'vitest';
import {
  APPLICATION_LIST_FILTERS,
  APPLICATION_LIST_LIMIT,
  DECIDED_WINDOW_DAYS,
  formatWaitingLabel,
  formatShortDate,
  formatDecisionLine,
  resolveApplicationFilter,
  toApplicationListRowView,
} from './application-list-view';
import type { ApplicationReviewRow } from '@balo/db';

const NOW = new Date('2026-01-15T00:00:00.000Z');
const DAY_MS = 86_400_000;

function baseRow(overrides: Partial<ApplicationReviewRow> = {}): ApplicationReviewRow {
  return {
    expertProfileId: 'p1',
    applicantUserId: 'u1',
    firstName: 'Priya',
    lastName: 'Shah',
    email: 'priya@example.com',
    agencyName: null,
    applicationStatus: 'submitted',
    submittedAt: NOW,
    decidedAt: null,
    decidedByFirstName: null,
    decidedByLastName: null,
    declineReason: null,
    ...overrides,
  };
}

describe('APPLICATION_LIST_LIMIT / DECIDED_WINDOW_DAYS', () => {
  it('are the plan-specified constants', () => {
    expect(APPLICATION_LIST_LIMIT).toBe(100);
    expect(DECIDED_WINDOW_DAYS).toBe(30);
  });
});

describe('resolveApplicationFilter', () => {
  it.each([undefined, 'nope', '__proto__', 'constructor', 'toString'])(
    'defaults to pending for %s',
    (raw) => {
      expect(resolveApplicationFilter(raw)).toBe('pending');
    }
  );

  it.each(APPLICATION_LIST_FILTERS)('resolves %s through unchanged', (filter) => {
    expect(resolveApplicationFilter(filter)).toBe(filter);
  });
});

describe('formatWaitingLabel', () => {
  it('renders "waiting today" under 1 day', () => {
    expect(formatWaitingLabel(0)).toBe('waiting today');
  });

  it('renders "waiting Nd" for whole days', () => {
    expect(formatWaitingLabel(6)).toBe('waiting 6d');
    expect(formatWaitingLabel(7)).toBe('waiting 7d');
  });
});

describe('formatShortDate', () => {
  it('formats as "D Mon"', () => {
    expect(formatShortDate(new Date('2026-09-03T00:00:00.000Z'))).toBe('3 Sep');
  });

  /**
   * FIX ROUND F15 — THE DETERMINISM PIN. The assertion above passes under either implementation
   * when the suite happens to run in UTC (CI's default, and nothing in `vitest.config.ts` or any
   * workflow sets `TZ`), so on its own it pins nothing.
   *
   * `2026-09-03T23:30Z` is the discriminating instant: in `Pacific/Kiritimati` (+14) its LOCAL
   * date is the 4th. MUTATION-PROVEN: swap `getUTCDate()`/`getUTCMonth()` back to
   * `getDate()`/`getMonth()` and this goes red — `'4 Sep'` — while every other test stays green.
   *
   * Node re-reads `process.env.TZ` on assignment, so this is a real timezone switch, restored in
   * `finally` so no later test inherits it.
   */
  it('renders the SAME date in a non-UTC deployment timezone', () => {
    // The `zoned-grid.test.ts` read-then-restore precedent, disables and all.
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- read-then-restore, test-only
    const originalTz = process.env.TZ;
    try {
      // eslint-disable-next-line turbo/no-undeclared-env-vars -- read-then-restore, test-only
      process.env.TZ = 'Pacific/Kiritimati'; // UTC+14 — the widest positive offset there is
      expect(formatShortDate(new Date('2026-09-03T23:30:00.000Z'))).toBe('3 Sep');
      // eslint-disable-next-line turbo/no-undeclared-env-vars -- read-then-restore, test-only
      process.env.TZ = 'Pacific/Niue'; // UTC−11, the other direction
      expect(formatShortDate(new Date('2026-09-03T00:30:00.000Z'))).toBe('3 Sep');
    } finally {
      // eslint-disable-next-line turbo/no-undeclared-env-vars -- read-then-restore, test-only
      process.env.TZ = originalTz;
    }
  });
});

describe('formatDecisionLine', () => {
  it('names the person @ Balo, retrospectively, for an approve', () => {
    const line = formatDecisionLine({
      decision: 'approved',
      decidedByFirstName: 'Dana',
      decidedByLastName: null,
      decidedAt: new Date('2026-09-03T00:00:00.000Z'),
    });
    expect(line).toBe('Approved by Dana @ Balo · 3 Sep');
  });

  it('says Declined, never Rejected, for a decline (D2)', () => {
    const line = formatDecisionLine({
      decision: 'declined',
      decidedByFirstName: 'Dana',
      decidedByLastName: 'K',
      decidedAt: new Date('2026-09-03T00:00:00.000Z'),
    });
    expect(line).toBe('Declined by Dana K @ Balo · 3 Sep');
    expect(line).not.toContain('Rejected');
  });

  it('falls back to a neutral label when no decider name is available', () => {
    const line = formatDecisionLine({
      decision: 'approved',
      decidedByFirstName: null,
      decidedByLastName: null,
      decidedAt: new Date('2026-09-03T00:00:00.000Z'),
    });
    expect(line).toBe('Approved by A Balo staff member @ Balo · 3 Sep');
  });
});

describe('toApplicationListRowView', () => {
  it('uses the applicant name, or the email when no name is set', () => {
    const withName = toApplicationListRowView(baseRow(), 'pending', NOW);
    expect(withName.name).toBe('Priya Shah');

    const noName = toApplicationListRowView(
      baseRow({ firstName: null, lastName: null }),
      'pending',
      NOW
    );
    expect(noName.name).toBe('priya@example.com');
  });

  it('labels an independent expert, and shows the agency name otherwise', () => {
    const independent = toApplicationListRowView(baseRow(), 'pending', NOW);
    expect(independent.agencyLabel).toBe('Independent');

    const agency = toApplicationListRowView(baseRow({ agencyName: 'CloudPeak' }), 'pending', NOW);
    expect(agency.agencyLabel).toBe('CloudPeak');
  });

  it('the waiting label FLOORS and agrees with days_waiting on the same row (the 6d23h fixture)', () => {
    const submittedAt = new Date(NOW.getTime() - (6 * DAY_MS + 23 * 60 * 60 * 1000));
    const row = toApplicationListRowView(baseRow({ submittedAt }), 'pending', NOW);
    expect(row.statusLine).toBe('waiting 6d');
    expect(row.daysWaiting).toBe(6);
  });

  it('renders the retrospective decision line on the decided arms, not the waiting label', () => {
    const decidedAt = new Date('2026-01-10T00:00:00.000Z');
    const row = toApplicationListRowView(
      baseRow({
        applicationStatus: 'approved',
        decidedAt,
        decidedByFirstName: 'Dana',
        decidedByLastName: null,
      }),
      'approved',
      NOW
    );
    expect(row.statusLine).toContain('Approved by Dana @ Balo');
    expect(row.statusLine).not.toContain('waiting');
  });

  it('renders "Declined by …", never "Rejected by …", on the declined arm', () => {
    const decidedAt = new Date('2026-01-10T00:00:00.000Z');
    const row = toApplicationListRowView(
      baseRow({
        applicationStatus: 'rejected',
        decidedAt,
        decidedByFirstName: 'Dana',
        decidedByLastName: null,
        declineReason: 'not_a_fit',
      }),
      'declined',
      NOW
    );
    expect(row.statusLine).toContain('Declined by Dana @ Balo');
    expect(row.statusLine).not.toContain('Rejected');
  });
});
