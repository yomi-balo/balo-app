import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/(dashboard)/settings/team/_actions/add-domain', () => ({
  addPartyDomain: vi.fn(),
}));

import { AddDomainForm } from './add-domain-form';
import { addPartyDomain } from '@/app/(dashboard)/settings/team/_actions/add-domain';
import { toast } from 'sonner';

const addMock = vi.mocked(addPartyDomain);
const toastSuccess = vi.mocked(toast.success);

const PARTY_ID = '22222222-2222-4222-8222-222222222222';

function renderForm(): void {
  render(<AddDomainForm partyType="company" partyId={PARTY_ID} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AddDomainForm', () => {
  it('shows an inline format error and does NOT call the action for invalid input', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText(/add a domain/i), 'notadomain');
    await user.click(screen.getByRole('button', { name: /add domain/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/that doesn't look like a domain/i);
    expect(addMock).not.toHaveBeenCalled();
  });

  it('shows the empty-input error when submitting a blank field', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: /add domain/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter a domain to add/i);
    expect(addMock).not.toHaveBeenCalled();
  });

  it('submits the normalised domain, toasts, clears the field, and shows the audit note', async () => {
    addMock.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderForm();

    const input = screen.getByLabelText(/add a domain/i);
    await user.type(input, 'https://Acme.com/join');
    await user.click(screen.getByRole('button', { name: /add domain/i }));

    await waitFor(() => {
      expect(addMock).toHaveBeenCalledWith({
        partyType: 'company',
        partyId: PARTY_ID,
        domain: 'acme.com',
      });
    });
    expect(toastSuccess).toHaveBeenCalledWith('Domain added');
    expect(input).toHaveValue('');
    expect(await screen.findByRole('status')).toHaveTextContent(/recorded in your audit log/i);
  });

  it('surfaces a server business error INLINE (not a toast)', async () => {
    addMock.mockResolvedValue({
      success: false,
      error: 'acme.com is already connected to another organisation on Balo.',
    });
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText(/add a domain/i), 'acme.com');
    await user.click(screen.getByRole('button', { name: /add domain/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /already connected to another organisation/i
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('disables the control while the submit is in flight', async () => {
    let resolveAction: (v: { success: true }) => void = () => {};
    addMock.mockReturnValue(
      new Promise((resolve) => {
        resolveAction = resolve;
      })
    );
    const user = userEvent.setup();
    renderForm();

    await user.type(screen.getByLabelText(/add a domain/i), 'acme.com');
    await user.click(screen.getByRole('button', { name: /add domain/i }));

    await waitFor(() => expect(screen.getByText(/adding…/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /add domain/i })).toBeDisabled();

    resolveAction({ success: true });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<AddDomainForm partyType="agency" partyId={PARTY_ID} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
