import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CalendarAddMenu } from './calendar-add-menu';

describe('CalendarAddMenu', () => {
  it('opens from an "Add calendar" button and lists every option in order', async () => {
    const user = userEvent.setup();
    render(
      <CalendarAddMenu
        options={[
          { provider: 'google', unavailableReason: null },
          { provider: 'microsoft', unavailableReason: null },
        ]}
        onSelect={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Add calendar' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Google Calendar', 'Microsoft Outlook']);
  });

  it('reports the selected provider', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <CalendarAddMenu
        options={[
          { provider: 'google', unavailableReason: null },
          { provider: 'microsoft', unavailableReason: null },
        ]}
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Add calendar' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Microsoft Outlook' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('microsoft');
  });

  it('keeps an unavailable option listed but disabled, with its reason beside it', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <CalendarAddMenu
        options={[
          { provider: 'google', unavailableReason: 'Connected' },
          { provider: 'microsoft', unavailableReason: null },
        ]}
        onSelect={onSelect}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Add calendar' }));
    const google = await screen.findByRole('menuitem', { name: /Google Calendar/ });
    expect(google).toHaveAttribute('aria-disabled', 'true');
    expect(google).toHaveTextContent('Google CalendarConnected');
    const microsoft = screen.getByRole('menuitem', { name: 'Microsoft Outlook' });
    expect(microsoft).not.toHaveAttribute('aria-disabled');

    await user.click(google);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
