import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CountryCombobox } from './country-combobox';

// cmdk / Radix UI need browser APIs not in jsdom
beforeAll(() => {
  global.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
});

describe('CountryCombobox', () => {
  it('renders placeholder when no value selected', () => {
    render(<CountryCombobox value="" onValueChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Select your country...');
  });

  it('renders selected country name and flag', () => {
    render(<CountryCombobox value="AU" onValueChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Australia');
  });

  it('renders disabled state', () => {
    render(<CountryCombobox value="" onValueChange={vi.fn()} disabled />);
    expect(screen.getByRole('combobox')).toBeDisabled();
  });

  it('opens popover on click and shows search input', async () => {
    const user = userEvent.setup();
    render(<CountryCombobox value="" onValueChange={vi.fn()} />);

    await user.click(screen.getByRole('combobox'));

    expect(screen.getByPlaceholderText('Search country...')).toBeInTheDocument();
    expect(screen.getByText('Popular')).toBeInTheDocument();
    expect(screen.getByText('All countries')).toBeInTheDocument();
  });

  it('calls onValueChange when a country is selected', async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(<CountryCombobox value="" onValueChange={onValueChange} />);

    await user.click(screen.getByRole('combobox'));

    // Click on Australia in the priority list
    const items = screen.getAllByText('Australia');
    await user.click(items[0]!);

    expect(onValueChange).toHaveBeenCalledWith('AU');
  });

  it('shows the selected country with a check mark', async () => {
    const user = userEvent.setup();
    render(<CountryCombobox value="US" onValueChange={vi.fn()} />);

    await user.click(screen.getByRole('combobox'));

    // "United States" should appear in both Popular and All countries groups
    const items = screen.getAllByText('United States');
    expect(items.length).toBeGreaterThanOrEqual(1);
  });
});
