import { describe, it, expect } from 'vitest';
import {
  APPLICATION_LIST_FILTERS,
  APPLICATION_LIST_LIMIT,
  DECIDED_WINDOW_DAYS,
  formatWaitingLabel,
  formatDecisionAttribution,
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

/**
 * WEB-REVIEW FIX ROUND W4 — `formatShortDate` AND ITS TESTS ARE GONE ON PURPOSE.
 *
 * Fix-round F15 made that formatter DETERMINISTIC (`getUTC*`, never `getMonth()`/`getDate()`, so
 * the same instant prints the same label on every host) and pinned it with a +14/−11 timezone
 * switch. The determinism was right; the READING was wrong — for Melbourne staff, a decision
 * recorded before ~10am AEST rendered as the previous calendar day on the one surface that
 * answers "when was this decided".
 *
 * The date now renders through the shipped `<LocalDate>`, in the VIEWER's timezone, so the
 * assertion moved to where the date is: `decision-outcome-banner.test.tsx` pins the viewer-local
 * label under a pinned non-UTC `TZ` (the same discriminating instant, `2026-09-03T23:30Z`), and
 * `local-date.test.ts` still pins the UTC first paint. NOTHING here reads a local getter
 * server-side any more, which is the property F15 actually cared about.
 */
describe('formatDecisionAttribution', () => {
  it('names the person @ Balo, retrospectively, for an approve — and carries NO date', () => {
    const line = formatDecisionAttribution({
      decision: 'approved',
      decidedByFirstName: 'Dana',
      decidedByLastName: null,
    });
    expect(line).toBe('Approved by Dana @ Balo');
  });

  it('says Declined, never Rejected, for a decline (D2)', () => {
    const line = formatDecisionAttribution({
      decision: 'declined',
      decidedByFirstName: 'Dana',
      decidedByLastName: 'K',
    });
    expect(line).toBe('Declined by Dana K @ Balo');
    expect(line).not.toContain('Rejected');
  });

  it('falls back to a neutral label when no decider name is available', () => {
    const line = formatDecisionAttribution({
      decision: 'approved',
      decidedByFirstName: null,
      decidedByLastName: null,
    });
    expect(line).toBe('Approved by A Balo staff member @ Balo');
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

  /** W4 — a pending row has no decision, so there is no date for `<LocalDate>` to render. */
  it('carries no decidedAtIso on a pending row', () => {
    const row = toApplicationListRowView(
      baseRow({ decidedAt: new Date('2026-01-10T00:00:00.000Z') }),
      'pending',
      NOW
    );
    expect(row.decidedAtIso).toBeNull();
    expect(row.statusLine).toContain('waiting');
  });

  /**
   * W4 — a decided row hands the raw INSTANT to the view, never a formatted date: the label is
   * the attribution only, and `<LocalDate>` renders the day in the viewer's own zone.
   *
   * MUTATION-PROVEN: put the date back inside `formatDecisionAttribution` and this goes red on
   * the `statusLine` assertion; drop `decidedAtIso` from the mapper and it goes red on the ISO.
   */
  it('renders the retrospective attribution plus the raw ISO instant on the decided arms', () => {
    const decidedAt = new Date('2026-01-10T22:45:00.000Z');
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
    expect(row.statusLine).toBe('Approved by Dana @ Balo');
    expect(row.statusLine).not.toContain('waiting');
    expect(row.decidedAtIso).toBe('2026-01-10T22:45:00.000Z');
  });

  /** A decided filter with a null `decided_at` (hand-written data only) keeps the old fallback. */
  it('falls back to the waiting label when a decided filter meets a null decided_at', () => {
    const row = toApplicationListRowView(
      baseRow({ applicationStatus: 'approved', decidedAt: null }),
      'approved',
      NOW
    );
    expect(row.statusLine).toBe('waiting today');
    expect(row.decidedAtIso).toBeNull();
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
