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

  it('sets aria-invalid="true" when invalid, and omits the attribute entirely otherwise', () => {
    const { rerender } = render(
      <ScheduleTimeSelect value="09:00" onChange={vi.fn()} ariaLabel="Monday start time" invalid />
    );
    expect(screen.getByRole('combobox', { name: 'Monday start time' })).toHaveAttribute(
      'aria-invalid',
      'true'
    );

    rerender(<ScheduleTimeSelect value="09:00" onChange={vi.fn()} ariaLabel="Monday start time" />);
    expect(
      screen.getByRole('combobox', { name: 'Monday start time' }).hasAttribute('aria-invalid')
    ).toBe(false);
  });

  it('forwards ariaDescribedBy verbatim', () => {
    render(
      <ScheduleTimeSelect
        value="09:00"
        onChange={vi.fn()}
        ariaLabel="Monday start time"
        ariaDescribedBy="badge-1 err-1"
      />
    );
    expect(screen.getByRole('combobox', { name: 'Monday start time' })).toHaveAttribute(
      'aria-describedby',
      'badge-1 err-1'
    );
  });
});
