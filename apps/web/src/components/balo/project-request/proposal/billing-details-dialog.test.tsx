import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@/test/utils';

// Mock the Server Action so the client dialog renders + fires in JSDOM (and never
// pulls @balo/db). The form→action seam is exactly what this suite asserts.
const mockSubmit = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/submit-billing-details', () => ({
  submitBillingDetailsAction: (...args: unknown[]) => mockSubmit(...args),
}));

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const mockRefresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

import { toast } from 'sonner';
import { BillingDetailsDialog } from './billing-details-dialog';
import type { CapturedBillingDetails } from '@/lib/billing/billing-capture';

const mockToast = vi.mocked(toast);

const DETAILS: CapturedBillingDetails = {
  legalName: 'Acme Pty Ltd',
  countryCode: 'AU',
  taxId: '51 824 753 556',
  address: null,
  billingEmail: 'ap@acme.example',
};

type DialogProps = React.ComponentProps<typeof BillingDetailsDialog>;

function renderDialog(overrides: Partial<DialogProps> = {}): {
  onOpenChange: ReturnType<typeof vi.fn>;
} {
  const onOpenChange = vi.fn();
  render(
    <BillingDetailsDialog
      open
      onOpenChange={onOpenChange}
      mode="create"
      requestId="req-1"
      relationshipId="rel-1"
      details={null}
      {...overrides}
    />
  );
  return { onOpenChange };
}

describe('BillingDetailsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubmit.mockResolvedValue({ success: true });
  });

  it('view mode renders the captured details and toggles into the edit form', () => {
    renderDialog({ mode: 'view', details: DETAILS });
    expect(screen.getByText('Acme Pty Ltd')).toBeInTheDocument();
    expect(screen.getByText('Australia')).toBeInTheDocument();
    expect(screen.getByText('51 824 753 556')).toBeInTheDocument();
    expect(screen.getByText('ap@acme.example')).toBeInTheDocument();
    // No form fields while read-only.
    expect(screen.queryByLabelText('Legal / entity name')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Edit details/i }));
    expect(screen.getByLabelText('Legal / entity name')).toBeInTheDocument();
  });

  it('submits the (prefilled) details, toasts success, closes, and refreshes', async () => {
    const { onOpenChange } = renderDialog({ mode: 'view', details: DETAILS });
    fireEvent.click(screen.getByRole('button', { name: /Edit details/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save billing details/i }));

    await waitFor(() => {
      expect(mockSubmit).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'req-1',
          relationshipId: 'rel-1',
          legalName: 'Acme Pty Ltd',
          countryCode: 'AU',
          taxId: '51 824 753 556',
          billingEmail: 'ap@acme.example',
        })
      );
    });
    expect(mockToast.success).toHaveBeenCalledWith('Billing details saved');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('keeps the dialog open and toasts on a failed submit', async () => {
    mockSubmit.mockResolvedValue({ success: false, error: 'This kickoff is no longer open.' });
    const { onOpenChange } = renderDialog({ mode: 'view', details: DETAILS });
    fireEvent.click(screen.getByRole('button', { name: /Edit details/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save billing details/i }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('This kickoff is no longer open.')
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('blocks submit with an inline error when no country is selected', async () => {
    renderDialog({ mode: 'create', details: null });
    fireEvent.change(screen.getByLabelText('Legal / entity name'), {
      target: { value: 'NewCo LLC' },
    });
    fireEvent.change(screen.getByLabelText(/Tax ID/i), { target: { value: 'X123' } });
    fireEvent.change(screen.getByLabelText('Billing email'), {
      target: { value: 'ops@newco.example' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save billing details/i }));

    await waitFor(() => expect(screen.getByText('Select a country')).toBeInTheDocument());
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('shows a spinner and disables the actions while submitting', async () => {
    let resolveSubmit!: (value: { success: true }) => void;
    mockSubmit.mockReturnValue(
      new Promise<{ success: true }>((resolve) => {
        resolveSubmit = resolve;
      })
    );
    renderDialog({ mode: 'view', details: DETAILS });
    fireEvent.click(screen.getByRole('button', { name: /Edit details/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save billing details/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Saving/i })).toBeDisabled());
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();

    resolveSubmit({ success: true });
  });
});
