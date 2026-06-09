import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { StatusStepper } from './status-stepper';

describe('StatusStepper', () => {
  it('renders all eight pipeline steps', () => {
    render(<StatusStepper current="requested" />);
    expect(screen.getByText('Requested')).toBeInTheDocument();
    expect(screen.getByText('Invited')).toBeInTheDocument();
    expect(screen.getByText('Kickoff')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: /Request progress/i })).toBeInTheDocument();
  });

  it('marks the current step with aria-current', () => {
    render(<StatusStepper current="eoi_submitted" />);
    const current = screen.getByText('EOIs in').closest('[aria-current="step"]');
    expect(current).not.toBeNull();
  });

  it('clamps a draft status to the first step (nothing done)', () => {
    render(<StatusStepper current="draft" />);
    // The "Requested" step is current at index 0 — no checkmarks before it.
    const current = screen.getByText('Requested').closest('[aria-current="step"]');
    expect(current).not.toBeNull();
  });

  it('marks earlier steps as done for a later status', () => {
    const { container } = render(<StatusStepper current="accepted" />);
    // Done steps render a checkmark icon (lucide svg).
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
  });
});
