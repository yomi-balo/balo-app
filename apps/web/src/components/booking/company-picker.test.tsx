import { beforeAll, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import type { EligibleCompany } from '@balo/shared/credit';
import { CompanyPicker, CompanyPickerErrorBanner } from './company-picker';

// Radix Select drives the open/select interaction through Pointer Capture APIs jsdom doesn't
// implement — stub them so the listbox can open (established pattern, `changes-modal.test.tsx`).
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

const COMPANIES: EligibleCompany[] = [
  { id: 'c1', name: 'Northwind Industrial', logoUrl: null },
  { id: 'c2', name: 'Acme Corp', logoUrl: null },
];

describe('CompanyPicker', () => {
  it('renders names only — no balance, no rate — with no default selection', () => {
    render(<CompanyPicker companies={COMPANIES} value={null} onChange={vi.fn()} />);
    expect(screen.getByText('Choose an account')).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('A$');
    expect(text).not.toContain('Balance');
  });

  it('calls onChange with the selected company id', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CompanyPicker companies={COMPANIES} value={null} onChange={onChange} />);
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /Acme Corp/i }));
    expect(onChange).toHaveBeenCalledWith('c2');
  });

  it('renders the required label and the non-personal-billing helper text', () => {
    render(<CompanyPicker companies={COMPANIES} value={null} onChange={vi.fn()} />);
    expect(screen.getByText(/Bill this session to/)).toBeInTheDocument();
    expect(
      screen.getByText('Consultations are billed to a company account, not to you personally.')
    ).toBeInTheDocument();
  });
});

describe('CompanyPickerErrorBanner', () => {
  it('renders the fail-closed retry banner and fires onRetry', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<CompanyPickerErrorBanner onRetry={onRetry} />);
    expect(screen.getByText("We couldn't check your company details.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
