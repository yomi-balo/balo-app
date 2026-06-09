import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { NudgeBar, nudgeFor, EXPERT_GATED_NUDGE } from './nudge-bar';

describe('NudgeBar', () => {
  it('renders the headline, sub, and the action eyebrow', () => {
    const nudge = nudgeFor('expert', 'experts_invited')!;
    render(<NudgeBar nudge={nudge} />);
    expect(screen.getByText(/submit your expression of interest/i)).toBeInTheDocument();
    expect(screen.getByText('Your next step')).toBeInTheDocument();
  });

  it('renders CTAs as disabled placeholders (sibling wiring)', () => {
    const nudge = nudgeFor('expert', 'experts_invited')!;
    render(<NudgeBar nudge={nudge} />);
    const primary = screen.getByRole('button', { name: /Write your EOI/i });
    expect(primary).toBeDisabled();
    const secondary = screen.getByRole('button', { name: /Re-read the brief/i });
    expect(secondary).toBeDisabled();
  });

  it('renders the Waiting eyebrow for waiting variants', () => {
    render(<NudgeBar nudge={EXPERT_GATED_NUDGE} />);
    expect(screen.getByText('Waiting')).toBeInTheDocument();
    expect(screen.getByText('Not yet visible to you')).toBeInTheDocument();
  });

  it('renders the Done eyebrow for done variants', () => {
    const nudge = nudgeFor('expert', 'kickoff_approved')!;
    render(<NudgeBar nudge={nudge} />);
    expect(screen.getByText('Done')).toBeInTheDocument();
  });
});

describe('nudgeFor', () => {
  it('returns a client nudge for a known client status', () => {
    expect(nudgeFor('client', 'requested')?.variant).toBe('waiting');
  });

  it('returns an admin triage nudge at requested', () => {
    expect(nudgeFor('admin', 'requested')?.headline).toMatch(/triage/i);
  });

  it('returns null for a cell with no nudge (client at eoi_submitted)', () => {
    expect(nudgeFor('client', 'eoi_submitted')).toBeNull();
  });

  it('covers every lens for the experts_invited status', () => {
    expect(nudgeFor('client', 'experts_invited')).not.toBeNull();
    expect(nudgeFor('expert', 'experts_invited')).not.toBeNull();
    expect(nudgeFor('admin', 'experts_invited')).not.toBeNull();
  });
});
