import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScheduleDstWarning } from './schedule-dst-warning';

describe('ScheduleDstWarning', () => {
  it('renders a non-blocking alert with the formatted gap date and times', () => {
    render(
      <ScheduleDstWarning
        gap={{
          dateISO: '2026-10-04',
          dayOfWeek: 0,
          gapStartMinutes: 120,
          gapEndMinutes: 180,
        }}
        timezone="Australia/Melbourne"
      />
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/daylight saving/i);
    expect(alert).toHaveTextContent(/Sunday, October 4, 2026/);
    expect(alert).toHaveTextContent(/2:00 AM/);
    expect(alert).toHaveTextContent(/3:00 AM/);
    expect(alert).toHaveTextContent(/Melbourne/);
  });
});
