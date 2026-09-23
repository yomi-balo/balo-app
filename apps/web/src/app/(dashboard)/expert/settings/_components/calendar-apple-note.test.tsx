import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CalendarAppleNote } from './calendar-apple-note';

describe('CalendarAppleNote', () => {
  it('names iCloud and points at what still works, without promising Apple sync', () => {
    render(<CalendarAppleNote />);
    const note = screen.getByText(/On iCloud\?/);
    expect(note).toHaveTextContent(/Apple calendars can't be connected yet/);
    expect(note).toHaveTextContent(/your weekly hours still work on their own/);
    expect(note).toHaveTextContent(/clients can book you as normal/);
    // iCloud is parked (apiroc skill, constraint 8) — nothing here may promise it is imminent.
    expect(note).not.toHaveTextContent(/coming soon/i);
  });
});
