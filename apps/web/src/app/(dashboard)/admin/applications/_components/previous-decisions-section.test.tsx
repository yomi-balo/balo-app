import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import {
  PreviousDecisionsSection,
  type PreviousDecisionRowView,
} from './previous-decisions-section';

const DECIDED_AT = new Date('2026-01-08T00:00:00.000Z');
const SUBMITTED_AT = new Date('2026-01-01T00:00:00.000Z');

function row(overrides: Partial<PreviousDecisionRowView> = {}): PreviousDecisionRowView {
  return {
    id: 'decision-1',
    decidedByFirstName: 'Dana',
    decidedByLastName: null,
    decidedAt: DECIDED_AT,
    declineReason: 'not_a_fit',
    declineNote: null,
    submittedAt: SUBMITTED_AT,
    ...overrides,
  };
}

describe('PreviousDecisionsSection', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<PreviousDecisionsSection decisions={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders attribution, reason and both dates', () => {
    render(<PreviousDecisionsSection decisions={[row()]} />);
    expect(screen.getByText(/Declined by Dana @ Balo/)).toBeInTheDocument();
    expect(screen.getByText(/Not a fit right now/i)).toBeInTheDocument();
    expect(screen.getByText('8 Jan')).toBeInTheDocument();
    expect(screen.getByText(/Submitted/)).toBeInTheDocument();
    expect(screen.getByText('1 Jan')).toBeInTheDocument();
  });

  it('renders the note only when passed, behind a Lock glyph, labelled staff-only', () => {
    render(
      <PreviousDecisionsSection
        decisions={[row({ declineNote: 'A staff-only note about this applicant.' })]}
      />
    );
    expect(screen.getByText('A staff-only note about this applicant.')).toBeInTheDocument();
    expect(screen.getByText(/never shown to the applicant/i)).toBeInTheDocument();
  });

  it('renders no note section when declineNote is null', () => {
    render(<PreviousDecisionsSection decisions={[row({ declineNote: null })]} />);
    expect(screen.queryByText(/never shown to the applicant/i)).toBeNull();
  });

  it('renders multiple rows, one per decision', () => {
    render(
      <PreviousDecisionsSection
        decisions={[
          row({ id: 'decision-1', decidedByFirstName: 'Dana' }),
          row({ id: 'decision-2', decidedByFirstName: 'Priya' }),
        ]}
      />
    );
    expect(screen.getByText(/Declined by Dana @ Balo/)).toBeInTheDocument();
    expect(screen.getByText(/Declined by Priya @ Balo/)).toBeInTheDocument();
  });

  it('renders with no decidedAt/submittedAt (legacy row) without throwing', () => {
    render(<PreviousDecisionsSection decisions={[row({ decidedAt: null, submittedAt: null })]} />);
    expect(screen.getByText(/Declined by Dana @ Balo/)).toBeInTheDocument();
    expect(screen.queryByText(/Submitted/)).toBeNull();
  });
});
