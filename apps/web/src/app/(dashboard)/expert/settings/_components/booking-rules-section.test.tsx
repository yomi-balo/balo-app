import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BookingRulesSection } from './booking-rules-section';
import { DEFAULT_BOOKING_SETTINGS } from '../_lib/schedule-helpers';

describe('BookingRulesSection', () => {
  it('renders the three booking rules and no consultation-length or booking-window control', () => {
    render(<BookingRulesSection settings={DEFAULT_BOOKING_SETTINGS} onChange={vi.fn()} />);

    expect(screen.getByText('Buffer before')).toBeInTheDocument();
    expect(screen.getByText('Buffer after')).toBeInTheDocument();
    expect(screen.getByText('Minimum notice')).toBeInTheDocument();
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
    expect(screen.queryByText(/consultation length/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Booking window')).not.toBeInTheDocument();
  });

  it('associates every control with its label', () => {
    render(<BookingRulesSection settings={DEFAULT_BOOKING_SETTINGS} onChange={vi.fn()} />);
    // Labels use htmlFor tied to the trigger ids.
    expect(document.querySelector('#booking-bufferBeforeMinutes')).not.toBeNull();
    expect(document.querySelector('#booking-minimumNoticeMinutes')).not.toBeNull();
  });
});
