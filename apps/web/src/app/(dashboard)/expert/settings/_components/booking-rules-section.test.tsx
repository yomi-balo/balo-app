import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookingRulesSection } from './booking-rules-section';
import { DEFAULT_BOOKING_SETTINGS } from '../_lib/schedule-helpers';

// Radix Select opens through Pointer Capture APIs jsdom doesn't implement.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe('BookingRulesSection', () => {
  it('renders the three booking rules and no consultation-length or booking-window control', () => {
    render(<BookingRulesSection settings={DEFAULT_BOOKING_SETTINGS} onChange={vi.fn()} />);

    expect(screen.getByRole('heading', { level: 3, name: 'Booking rules' })).toBeInTheDocument();
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
    expect(screen.queryByText(/consultation length/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Booking window')).not.toBeInTheDocument();
  });

  it('names every control by its label and describes it with its help text', () => {
    render(<BookingRulesSection settings={DEFAULT_BOOKING_SETTINGS} onChange={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: 'Buffer before' })).toHaveAccessibleDescription(
      'Free time kept ahead of each consultation.'
    );
    expect(screen.getByRole('combobox', { name: 'Buffer after' })).toHaveAccessibleDescription(
      'Free time kept after each consultation.'
    );
    expect(screen.getByRole('combobox', { name: 'Minimum notice' })).toHaveAccessibleDescription(
      'The soonest a client can book you.'
    );
  });

  it('keeps the help text out of the visual layout', () => {
    render(<BookingRulesSection settings={DEFAULT_BOOKING_SETTINGS} onChange={vi.fn()} />);
    expect(screen.getByText('The soonest a client can book you.')).toHaveClass('sr-only');
  });

  it('lays the three fields out in three columns from the sm breakpoint, one on phones', () => {
    render(<BookingRulesSection settings={DEFAULT_BOOKING_SETTINGS} onChange={vi.fn()} />);
    const grid = screen.getByRole('combobox', { name: 'Buffer before' }).closest('.grid');
    expect(grid).toHaveClass('grid-cols-1', 'sm:grid-cols-3');
  });

  it('reports the changed rule with the other rules untouched', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<BookingRulesSection settings={DEFAULT_BOOKING_SETTINGS} onChange={onChange} />);

    await user.click(screen.getByRole('combobox', { name: 'Buffer after' }));
    await user.click(await screen.findByRole('option', { name: '30 min' }));

    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_BOOKING_SETTINGS, bufferAfterMinutes: 30 });
  });
});
