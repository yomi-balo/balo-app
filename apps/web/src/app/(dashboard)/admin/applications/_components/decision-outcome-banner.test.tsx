import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { DecisionOutcomeBanner } from './decision-outcome-banner';

const DECIDED_AT = new Date('2026-09-03T00:00:00.000Z');

describe('DecisionOutcomeBanner', () => {
  it('renders the approve line with the person @ Balo, no reason', () => {
    render(
      <DecisionOutcomeBanner
        decision="approved"
        decidedByFirstName="Dana"
        decidedByLastName={null}
        decidedAt={DECIDED_AT}
        declineReason={null}
        declineNote={null}
      />
    );
    expect(screen.getByText(/Approved by Dana @ Balo/)).toBeInTheDocument();
    // W4 — the date is a sibling `<time>`, not part of the attribution string.
    const when = screen.getByText('3 Sep');
    expect(when.tagName).toBe('TIME');
    expect(when).toHaveAttribute('datetime', '2026-09-03T00:00:00.000Z');
  });

  it('renders the decline line with the reason label, never "Rejected"', () => {
    render(
      <DecisionOutcomeBanner
        decision="declined"
        decidedByFirstName="Dana"
        decidedByLastName={null}
        decidedAt={DECIDED_AT}
        declineReason="not_a_fit"
        declineNote={null}
      />
    );
    expect(screen.getByText(/Declined by Dana @ Balo/)).toBeInTheDocument();
    expect(screen.getByText('3 Sep').tagName).toBe('TIME');
    expect(screen.getByText(/Not a fit right now/i)).toBeInTheDocument();
    expect(screen.queryByText(/Rejected/)).toBeNull();
  });

  /**
   * WEB-REVIEW FIX ROUND W4 — THE DATE IS THE **VIEWER'S** CALENDAR DAY, NOT UTC's.
   *
   * `2026-09-03T23:30Z` is the discriminating instant: in `Pacific/Kiritimati` (+14) its local
   * date is the 4th. The previous server-side UTC label printed "3 Sep" for every reader, which
   * is why a Melbourne staffer saw yesterday's date for anything decided before ~10am AEST.
   *
   * MUTATION-PROVEN: put the date back into the attribution string (a `getUTC*` formatter) and
   * this goes red — "3 Sep" — while the fixed-instant tests above stay green. The `<time>`
   * element's `datetime` attribute stays the UNAMBIGUOUS instant either way.
   *
   * Node re-reads `process.env.TZ` on assignment (the `zoned-grid.test.ts` / former
   * `formatShortDate` precedent), restored in `finally` so no later test inherits it.
   */
  it('renders the decision date in the VIEWER timezone, not UTC', () => {
    // eslint-disable-next-line turbo/no-undeclared-env-vars -- read-then-restore, test-only
    const originalTz = process.env.TZ;
    try {
      // eslint-disable-next-line turbo/no-undeclared-env-vars -- read-then-restore, test-only
      process.env.TZ = 'Pacific/Kiritimati'; // UTC+14 — the widest positive offset there is
      render(
        <DecisionOutcomeBanner
          decision="approved"
          decidedByFirstName="Dana"
          decidedByLastName={null}
          decidedAt={new Date('2026-09-03T23:30:00.000Z')}
          declineReason={null}
          declineNote={null}
        />
      );
      const when = screen.getByText('4 Sep');
      expect(when.tagName).toBe('TIME');
      expect(when).toHaveAttribute('datetime', '2026-09-03T23:30:00.000Z');
      expect(screen.queryByText('3 Sep')).toBeNull();
    } finally {
      // eslint-disable-next-line turbo/no-undeclared-env-vars -- read-then-restore, test-only
      process.env.TZ = originalTz;
    }
  });

  it('renders the decline note behind a Lock glyph, labelled as staff-only', () => {
    render(
      <DecisionOutcomeBanner
        decision="declined"
        decidedByFirstName="Dana"
        decidedByLastName={null}
        decidedAt={DECIDED_AT}
        declineReason="not_a_fit"
        declineNote="Internal staff note about this applicant."
      />
    );
    expect(screen.getByText('Internal staff note about this applicant.')).toBeInTheDocument();
    expect(screen.getByText(/never shown to the applicant/i)).toBeInTheDocument();
  });

  it('renders no note section when there is no note', () => {
    render(
      <DecisionOutcomeBanner
        decision="approved"
        decidedByFirstName="Dana"
        decidedByLastName={null}
        decidedAt={DECIDED_AT}
        declineReason={null}
        declineNote={null}
      />
    );
    expect(screen.queryByText(/never shown to the applicant/i)).toBeNull();
  });
});
