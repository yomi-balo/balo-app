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
    expect(screen.getByText(/Approved by Dana @ Balo · 3 Sep/)).toBeInTheDocument();
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
    expect(screen.getByText(/Declined by Dana @ Balo · 3 Sep/)).toBeInTheDocument();
    expect(screen.getByText(/Not a fit right now/i)).toBeInTheDocument();
    expect(screen.queryByText(/Rejected/)).toBeNull();
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
