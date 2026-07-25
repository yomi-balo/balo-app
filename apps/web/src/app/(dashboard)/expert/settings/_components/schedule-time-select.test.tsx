import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ScheduleTimeSelect } from './schedule-time-select';

describe('ScheduleTimeSelect', () => {
  it('renders an accessible time picker trigger', () => {
    render(<ScheduleTimeSelect value="09:00" onChange={vi.fn()} ariaLabel="Monday start time" />);
    expect(screen.getByRole('combobox', { name: 'Monday start time' })).toBeInTheDocument();
  });

  it('can be disabled', () => {
    render(
      <ScheduleTimeSelect value="09:00" onChange={vi.fn()} ariaLabel="Monday start time" disabled />
    );
    expect(screen.getByRole('combobox', { name: 'Monday start time' })).toBeDisabled();
  });
});
