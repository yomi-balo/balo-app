import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScheduleTimezoneCombobox } from './schedule-timezone-combobox';

describe('ScheduleTimezoneCombobox', () => {
  it('renders the selected timezone with a live current-time preview', () => {
    render(<ScheduleTimezoneCombobox value="Australia/Melbourne" onChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox', { name: 'Select your timezone' });
    expect(trigger).toHaveTextContent('Melbourne');
    // Live clock renders a time like "· 3:42 PM".
    expect(trigger.textContent).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/i);
  });

  it('opens the search list and selects a timezone', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ScheduleTimezoneCombobox value="Australia/Melbourne" onChange={onChange} />);

    await user.click(screen.getByRole('combobox', { name: 'Select your timezone' }));
    const listbox = await screen.findByRole('listbox');

    // Sydney appears in both the "Popular" and "All timezones" groups — click the first.
    const [sydney] = within(listbox).getAllByText('Sydney');
    expect(sydney).toBeDefined();
    if (sydney) await user.click(sydney);

    expect(onChange).toHaveBeenCalledWith('Australia/Sydney');
  });
});
