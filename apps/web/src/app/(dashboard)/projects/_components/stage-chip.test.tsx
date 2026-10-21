import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { StageChip } from './stage-chip';

describe('StageChip', () => {
  it('renders the label', () => {
    render(<StageChip stage="eoi" lens="client" label="Interest" />);
    expect(screen.getByText('Interest')).toBeInTheDocument();
  });

  it('merges a custom className', () => {
    render(<StageChip stage="requested" lens="client" label="Matching" className="custom-x" />);
    expect(screen.getByText('Matching')).toHaveClass('custom-x');
  });

  describe('participant lenses colour by the shared stage', () => {
    it.each(['requested', 'exploratory', 'invited'] as const)(
      'client %s reads Matching in primary',
      (stage) => {
        render(<StageChip stage={stage} lens="client" label="Matching" />);
        expect(screen.getByText('Matching')).toHaveClass('text-primary');
      }
    );

    it('expert invited is primary', () => {
      render(<StageChip stage="invited" lens="expert" label="Invited" />);
      expect(screen.getByText('Invited')).toHaveClass('text-primary');
    });

    it('eoi is violet', () => {
      render(<StageChip stage="eoi" lens="client" label="Interest" />);
      expect(screen.getByText('Interest')).toHaveClass('text-violet-600');
    });

    it.each(['prop_req', 'prop_in'] as const)('%s is warning', (stage) => {
      render(<StageChip stage={stage} lens="expert" label="Proposal" />);
      expect(screen.getByText('Proposal')).toHaveClass('text-warning-strong');
    });

    it.each(['accepted', 'kicked'] as const)('%s is success', (stage) => {
      render(<StageChip stage={stage} lens="client" label="Kickoff" />);
      expect(screen.getByText('Kickoff')).toHaveClass('text-success-strong');
    });

    it('closed is muted (BAL-540)', () => {
      render(<StageChip stage="closed" lens="expert" label="Closed" />);
      expect(screen.getByText('Closed')).toHaveClass('text-muted-foreground');
    });
  });

  describe('admin lens keeps the staff palette', () => {
    it('requested stays muted and exploratory stays info', () => {
      render(
        <>
          <StageChip stage="requested" lens="admin" label="Requested" />
          <StageChip stage="exploratory" lens="admin" label="Exploratory call" />
        </>
      );
      expect(screen.getByText('Requested')).toHaveClass('text-muted-foreground');
      expect(screen.getByText('Exploratory call')).toHaveClass('text-info-strong');
    });
  });
});
