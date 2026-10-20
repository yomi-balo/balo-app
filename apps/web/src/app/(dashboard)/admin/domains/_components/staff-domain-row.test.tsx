import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@/test/utils';
import { axe } from '@/test/axe';

const { mockRemove, mockToastSuccess, mockToastError, mockRefresh, mockCapture } = vi.hoisted(
  () => ({
    mockRefresh: vi.fn(),
    mockCapture: vi.fn(),
    mockRemove: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
  })
);

vi.mock('../_actions/remove-party-domain', () => ({
  removePartyDomainAction: (...a: unknown[]) => mockRemove(...a),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: mockCapture }));
vi.mock('sonner', () => ({
  toast: { success: mockToastSuccess, error: mockToastError },
}));

import { StaffDomainRow } from './staff-domain-row';
import type { StaffDomainRowView } from '../_lib/staff-domain-view';

const ROW: StaffDomainRowView = {
  id: 'row-1',
  domain: 'acme.com',
  badge: { label: 'Added by Balo', tone: 'neutral' },
  meta: 'Added by Sam Staff on 3 Oct 2026',
  reason: 'Asked by the CFO',
};

const renderRow = (overrides: Partial<React.ComponentProps<typeof StaffDomainRow>> = {}) => {
  const onChanged = vi.fn();
  const onBegin = vi.fn();
  const utils = render(
    <ul>
      <StaffDomainRow
        row={ROW}
        partyType="company"
        partyId="p-1"
        partyName="Acme"
        isLast={false}
        canManage
        onBegin={onBegin}
        onChanged={onChanged}
        {...overrides}
      />
    </ul>
  );
  return { onChanged, onBegin, ...utils };
};

beforeEach(() => vi.clearAllMocks());

describe('StaffDomainRow', () => {
  it('shows the domain, provenance badge, meta and the audit reason', () => {
    renderRow();
    expect(screen.getByText('acme.com')).toBeInTheDocument();
    expect(screen.getByText('Added by Balo')).toBeInTheDocument();
    expect(screen.getByText('Added by Sam Staff on 3 Oct 2026')).toBeInTheDocument();
    expect(screen.getByText('Asked by the CFO')).toBeInTheDocument();
  });

  it('omits the reason paragraph when there is none', () => {
    renderRow({ row: { ...ROW, reason: null } });
    expect(screen.queryByText('Asked by the CFO')).not.toBeInTheDocument();
  });

  it('styles the signup badge distinctly from staff badges', () => {
    renderRow({ row: { ...ROW, badge: { label: 'From signup', tone: 'signup' } } });
    expect(screen.getByText('From signup').className).toContain('text-primary');
  });

  it('offers no Remove control to a read-only viewer', () => {
    renderRow({ canManage: false });
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });

  it('uses the last-domain copy for the only domain', () => {
    renderRow({ isLast: true });
    fireEvent.click(screen.getByRole('button', { name: 'Remove acme.com' }));
    expect(screen.getByText(/last domain/i)).toBeInTheDocument();
  });

  it('Keep closes the confirmation without calling the action', () => {
    renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'Remove acme.com' }));
    expect(screen.getByText('Remove acme.com from Acme?')).toBeInTheDocument();
    expect(screen.getByText('Owners and admins of Acme will be notified.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Keep' }));

    expect(screen.queryByText('Remove acme.com from Acme?')).not.toBeInTheDocument();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  it('shows the reason error the server returns and does not report success', async () => {
    mockRemove.mockResolvedValue({
      success: false,
      field: 'reason',
      error: 'Add a reason so the audit log shows why this changed.',
    });
    const { onChanged } = renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'Remove acme.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove domain' }));

    expect(await screen.findByText(/add a reason so the audit log/i)).toBeInTheDocument();
    expect(mockRemove).toHaveBeenCalledWith({
      domainId: 'row-1',
      partyType: 'company',
      partyId: 'p-1',
      reason: '',
    });
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('removes with the typed reason, toasts and reports the status line', async () => {
    mockRemove.mockResolvedValue({ success: true, message: 'acme.com removed from Acme.' });
    const { onChanged } = renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'Remove acme.com' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Left the company' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove domain' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('acme.com removed from Acme.'));
    expect(mockRemove).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'Left the company' })
    );
    expect(mockToastSuccess).toHaveBeenCalledWith('acme.com removed from Acme.');
  });

  const startRemove = (): void => {
    fireEvent.click(screen.getByRole('button', { name: 'Remove acme.com' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove domain' }));
  };

  it('clears the previous status line when a remove starts', async () => {
    mockRemove.mockResolvedValue({ success: true, message: 'm' });
    const { onBegin } = renderRow();
    startRemove();
    await waitFor(() => expect(onBegin).toHaveBeenCalledTimes(1));
  });

  it('refreshes the route when the domain was already removed', async () => {
    mockRemove.mockResolvedValue({
      success: false,
      code: 'not_found',
      error: 'That domain was already removed.',
    });
    renderRow();
    startRemove();
    await waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(1));
  });

  it('reports an unexpected rejection to Sentry and toasts a generic error', async () => {
    mockRemove.mockRejectedValue(new Error('network'));
    renderRow();
    startRemove();
    await waitFor(() =>
      expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ message: 'network' }))
    );
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining('Something went wrong'));
  });

  it('surfaces a non-field failure inline and as a toast', async () => {
    mockRemove.mockResolvedValue({ success: false, error: 'That domain was already removed.' });
    renderRow();
    fireEvent.click(screen.getByRole('button', { name: 'Remove acme.com' }));
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove domain' }));

    expect(await screen.findByText('That domain was already removed.')).toBeInTheDocument();
    expect(mockToastError).toHaveBeenCalledWith('That domain was already removed.');
  });

  it('has no accessibility violations, collapsed or confirming', async () => {
    const { container } = renderRow();
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(screen.getByRole('button', { name: 'Remove acme.com' }));
    expect(await axe(container)).toHaveNoViolations();
  });
});
