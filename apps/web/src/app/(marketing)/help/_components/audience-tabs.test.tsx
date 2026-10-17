import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AudienceTabs } from './audience-tabs';

describe('AudienceTabs', () => {
  it('exposes a labelled tablist with the selected tab wired to the panel', () => {
    render(<AudienceTabs audience="client" onChange={vi.fn()} />);

    expect(screen.getByRole('tablist', { name: 'Who the guides are for' })).toBeInTheDocument();
    const client = screen.getByRole('tab', { name: /I’m hiring experts/ });
    const expert = screen.getByRole('tab', { name: /I work as an expert/ });
    expect(client).toHaveAttribute('aria-selected', 'true');
    expect(client).toHaveAttribute('aria-controls', 'help-panel');
    expect(client).toHaveAttribute('id', 'help-tab-client');
    expect(client).toHaveAttribute('tabindex', '0');
    expect(expert).toHaveAttribute('aria-selected', 'false');
    expect(expert).toHaveAttribute('tabindex', '-1');
  });

  it('shows the sub copy for the selected tab only', () => {
    render(<AudienceTabs audience="expert" onChange={vi.fn()} />);

    expect(screen.getByText(/Getting approved, getting booked/)).toBeInTheDocument();
    expect(screen.queryByText(/Booking consultations/)).not.toBeInTheDocument();
  });

  it('selects a tab on click', async () => {
    const onChange = vi.fn();
    render(<AudienceTabs audience="client" onChange={onChange} />);

    await userEvent.click(screen.getByRole('tab', { name: /I work as an expert/ }));

    expect(onChange).toHaveBeenCalledWith('expert');
  });

  it('moves selection and focus with the arrow keys', async () => {
    const onChange = vi.fn();
    render(<AudienceTabs audience="client" onChange={onChange} />);
    screen.getByRole('tab', { name: /I’m hiring experts/ }).focus();

    await userEvent.keyboard('{ArrowRight}');

    expect(onChange).toHaveBeenCalledWith('expert');
    expect(screen.getByRole('tab', { name: /I work as an expert/ })).toHaveFocus();
  });

  it('jumps to the first side on Home and the last on End', async () => {
    const onChange = vi.fn();
    render(<AudienceTabs audience="expert" onChange={onChange} />);
    screen.getByRole('tab', { name: /I work as an expert/ }).focus();

    await userEvent.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith('client');

    await userEvent.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('expert');
  });

  it('ignores unrelated keys', async () => {
    const onChange = vi.fn();
    render(<AudienceTabs audience="client" onChange={onChange} />);
    screen.getByRole('tab', { name: /I’m hiring experts/ }).focus();

    await userEvent.keyboard('a');

    expect(onChange).not.toHaveBeenCalled();
  });
});
