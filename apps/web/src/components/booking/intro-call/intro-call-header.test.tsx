import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { IntroCallHeader } from './intro-call-header';

describe('IntroCallHeader', () => {
  it('renders the expert identity and the two-step stepper with "Confirm" (not "Review & confirm")', () => {
    render(<IntroCallHeader expertName="Priya Nair" expertInitials="PN" step="pick_time" />);
    expect(screen.getByText('Priya Nair')).toBeInTheDocument();
    expect(screen.getByText('Choose a time')).toBeInTheDocument();
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(screen.queryByText('Review & confirm')).not.toBeInTheDocument();
  });

  it('marks the active step with aria-current="step"', () => {
    render(<IntroCallHeader expertName="Priya Nair" expertInitials="PN" step="confirm" />);
    expect(screen.getByText('Confirm')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByText('Choose a time')).not.toHaveAttribute('aria-current');
  });

  it('shows "Booking confirmed" instead of the stepper once booked', () => {
    render(<IntroCallHeader expertName="Priya Nair" expertInitials="PN" step="booked" />);
    expect(screen.getByText('Booking confirmed')).toBeInTheDocument();
    expect(screen.queryByText('Choose a time')).not.toBeInTheDocument();
  });
});
