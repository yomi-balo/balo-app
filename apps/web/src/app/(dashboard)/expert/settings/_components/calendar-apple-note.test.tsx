import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CalendarAppleNote } from './calendar-apple-note';

describe('CalendarAppleNote', () => {
  it('names iCloud and frames Apple sync as coming soon, not a dead end', () => {
    render(<CalendarAppleNote />);
    expect(screen.getByText(/On iCloud\?/)).toBeInTheDocument();
    expect(screen.getByText(/coming soon/)).toBeInTheDocument();
    expect(screen.getByText(/clients can still book you/)).toBeInTheDocument();
  });
});
