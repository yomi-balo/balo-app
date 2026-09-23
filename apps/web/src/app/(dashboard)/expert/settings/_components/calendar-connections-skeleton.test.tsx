import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CalendarConnectionsSkeleton } from './calendar-connections-skeleton';

describe('CalendarConnectionsSkeleton', () => {
  it('renders an accessible loading indicator, not role="status"', () => {
    render(<CalendarConnectionsSkeleton />);
    const output = screen.getByLabelText('Loading');
    expect(output.tagName.toLowerCase()).toBe('output');
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders placeholder rows with no card shell of its own — it sits inside the Calendars card', () => {
    const { container } = render(<CalendarConnectionsSkeleton />);
    expect(container.querySelector('[data-slot="card"]')).toBeNull();
    const rows = screen.getByLabelText('Loading').firstElementChild;
    expect(rows?.children).toHaveLength(2);
  });
});
