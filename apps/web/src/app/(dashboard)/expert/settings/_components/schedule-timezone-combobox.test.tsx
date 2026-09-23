import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScheduleTimezoneCombobox } from './schedule-timezone-combobox';

describe('ScheduleTimezoneCombobox', () => {
  it('renders a "Change timezone" trigger that opens the search list', async () => {
    const user = userEvent.setup();
    render(<ScheduleTimezoneCombobox value="Australia/Melbourne" onChange={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: 'Change timezone' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(await screen.findByPlaceholderText('Search timezone…')).toBeInTheDocument();
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByText('Popular')).toBeInTheDocument();
    expect(within(listbox).getByText('All timezones')).toBeInTheDocument();
  });

  it('marks the current timezone and lists UTC for a fresh profile', async () => {
    const user = userEvent.setup();
    render(<ScheduleTimezoneCombobox value="UTC" onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Change timezone' }));
    const listbox = await screen.findByRole('listbox');
    const [utcOption] = within(listbox).getAllByRole('option', { name: /UTC/ });
    if (!utcOption) throw new Error('expected a UTC option');
    // The check icon is the option's first child; it is only opaque on the current zone.
    expect(utcOption.querySelector('svg')).toHaveClass('opacity-100');
  });

  it('selects a timezone from the list and closes', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ScheduleTimezoneCombobox value="Australia/Melbourne" onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Change timezone' }));
    const listbox = await screen.findByRole('listbox');

    // Sydney appears in both the "Popular" and "All timezones" groups — click the first.
    const [sydney] = within(listbox).getAllByText('Sydney');
    if (!sydney) throw new Error('expected a Sydney option');
    await user.click(sydney);

    expect(onChange).toHaveBeenCalledWith('Australia/Sydney');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('filters by search text and selects with the keyboard', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ScheduleTimezoneCombobox value="Australia/Melbourne" onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'Change timezone' }));
    await user.type(await screen.findByPlaceholderText('Search timezone…'), 'Tokyo');
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith('Asia/Tokyo');
  });

  it('can be disabled', () => {
    render(<ScheduleTimezoneCombobox value="UTC" onChange={vi.fn()} disabled />);
    expect(screen.getByRole('button', { name: 'Change timezone' })).toBeDisabled();
  });
});
