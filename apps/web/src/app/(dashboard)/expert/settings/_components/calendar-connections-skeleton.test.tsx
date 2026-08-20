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
});
