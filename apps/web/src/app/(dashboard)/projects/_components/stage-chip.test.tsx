import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { StageChip } from './stage-chip';

describe('StageChip', () => {
  it('renders the label', () => {
    render(<StageChip stage="eoi" label="In conversation" />);
    expect(screen.getByText('In conversation')).toBeInTheDocument();
  });

  it('applies the success token classes for the kicked stage', () => {
    render(<StageChip stage="kicked" label="Kicked off" />);
    expect(screen.getByText('Kicked off')).toHaveClass('text-success');
  });

  it('applies the primary token classes for the invited stage', () => {
    render(<StageChip stage="invited" label="Experts invited" />);
    expect(screen.getByText('Experts invited')).toHaveClass('text-primary');
  });

  it('merges a custom className', () => {
    render(<StageChip stage="requested" label="Requested" className="custom-x" />);
    expect(screen.getByText('Requested')).toHaveClass('custom-x');
  });
});
