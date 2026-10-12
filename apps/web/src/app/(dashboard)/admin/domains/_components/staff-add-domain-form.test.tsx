import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@/test/utils';
import { axe } from 'jest-axe';

const { mockAdd, mockReassign, mockToastSuccess, mockToastError, mockRefresh, mockCapture } =
  vi.hoisted(() => ({
    mockRefresh: vi.fn(),
    mockCapture: vi.fn(),
    mockAdd: vi.fn(),
    mockReassign: vi.fn(),
    mockToastSuccess: vi.fn(),
    mockToastError: vi.fn(),
  }));

vi.mock('../_actions/add-party-domain', () => ({
  addPartyDomainAction: (...a: unknown[]) => mockAdd(...a),
}));
vi.mock('../_actions/reassign-party-domain', () => ({
  reassignPartyDomainAction: (...a: unknown[]) => mockReassign(...a),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));
vi.mock('@sentry/nextjs', () => ({ captureException: mockCapture }));
vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: mockToastError } }));

import { StaffAddDomainForm } from './staff-add-domain-form';
import type { ConflictOwnerView } from '../_lib/staff-domain-types';

const OWNER: ConflictOwnerView = {
  domainId: 'owner-row',
  partyType: 'agency',
  partyId: 'agency-1',
  partyName: 'Globex',
  memberCount: 4,
  source: 'auto_captured',
  addedVia: 'signup',
  createdAt: '2026-10-03T08:00:00.000Z',
  createdByName: 'Dana Lee',
};

const setup = () => {
  const onChanged = vi.fn();
  const onBegin = vi.fn();
  const utils = render(
    <StaffAddDomainForm
      partyType="company"
      partyId="p-1"
      partyName="Acme"
      onBegin={onBegin}
      onChanged={onChanged}
    />
  );
  return { onChanged, onBegin, ...utils };
};

const type = (label: string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const submit = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};

beforeEach(() => vi.clearAllMocks());

describe('StaffAddDomainForm', () => {
  it('validates the domain on the client before any server call', () => {
    setup();
    type('Domain', 'not a domain');
    submit('Add domain');

    expect(screen.getByRole('alert')).toHaveTextContent(/doesn't look like a domain/i);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('lowercases input and adds with the reason, then resets and reports the status', async () => {
    mockAdd.mockResolvedValue({ success: true, message: 'acme.com added to Acme.' });
    const { onChanged } = setup();
    type('Domain', 'ACME.com');
    type('Reason', 'Customer asked');
    submit('Add domain');

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('acme.com added to Acme.'));
    expect(mockAdd).toHaveBeenCalledWith({
      partyType: 'company',
      partyId: 'p-1',
      domain: 'acme.com',
      reason: 'Customer asked',
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('acme.com added to Acme.');
    await waitFor(() => expect(screen.getByLabelText('Domain')).toHaveFocus());
    expect(screen.getByLabelText('Domain')).toHaveValue('');
    expect(screen.getByLabelText('Reason')).toHaveValue('');
  });

  it('shows a server domain error under the domain field', async () => {
    mockAdd.mockResolvedValue({
      success: false,
      field: 'domain',
      error: 'acme.com is already on Acme.',
    });
    setup();
    type('Domain', 'acme.com');
    submit('Add domain');

    expect(await screen.findByText('acme.com is already on Acme.')).toBeInTheDocument();
    expect(screen.getByLabelText('Domain')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a server reason error under the reason field', async () => {
    mockAdd.mockResolvedValue({
      success: false,
      field: 'reason',
      error: 'Add a reason so the audit log shows why this changed.',
    });
    setup();
    type('Domain', 'acme.com');
    submit('Add domain');

    expect(await screen.findByText(/add a reason so the audit log/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toHaveAttribute('aria-invalid', 'true');
  });

  it('toasts and shows an unscoped failure', async () => {
    mockAdd.mockResolvedValue({
      success: false,
      error: 'You do not have permission to do this.',
      code: 'denied',
    });
    setup();
    type('Domain', 'acme.com');
    submit('Add domain');

    expect(await screen.findByText('You do not have permission to do this.')).toBeInTheDocument();
    expect(mockToastError).toHaveBeenCalledWith('You do not have permission to do this.');
  });

  describe('conflict', () => {
    const triggerConflict = async (): Promise<void> => {
      mockAdd.mockResolvedValue({
        success: false,
        code: 'owned_by_other',
        error: 'acme.com belongs to Globex',
        owner: OWNER,
      });
      type('Domain', 'acme.com');
      submit('Add domain');
      await screen.findByText('acme.com belongs to Globex');
    };

    it('shows the panel, flips the button to Reassign and names both parties in the notify line', async () => {
      setup();
      await triggerConflict();

      expect(screen.getByRole('button', { name: 'Reassign to Acme' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
      expect(
        screen.getByText('Owners and admins of Globex and Acme will be notified.')
      ).toBeInTheDocument();
    });

    it('the second press reassigns with the owner as `expected`', async () => {
      mockReassign.mockResolvedValue({ success: true, message: 'acme.com moved.' });
      const { onChanged } = setup();
      await triggerConflict();
      type('Reason', 'Customer moved agencies');
      submit('Reassign to Acme');

      await waitFor(() => expect(onChanged).toHaveBeenCalledWith('acme.com moved.'));
      expect(mockReassign).toHaveBeenCalledWith({
        expectedDomainId: 'owner-row',
        fromPartyType: 'agency',
        fromPartyId: 'agency-1',
        toPartyType: 'company',
        toPartyId: 'p-1',
        domain: 'acme.com',
        reason: 'Customer moved agencies',
      });
      expect(mockToastSuccess).toHaveBeenCalledWith('acme.com moved.');
      expect(mockAdd).toHaveBeenCalledTimes(1);
    });

    it('Cancel clears the conflict', async () => {
      setup();
      await triggerConflict();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByText('acme.com belongs to Globex')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add domain' })).toBeInTheDocument();
    });

    it('editing the domain clears the conflict', async () => {
      setup();
      await triggerConflict();
      type('Domain', 'other.com');
      expect(screen.queryByText('acme.com belongs to Globex')).not.toBeInTheDocument();
    });

    it('a stale reassign drops the panel and shows the stale message', async () => {
      mockReassign.mockResolvedValue({
        success: false,
        code: 'stale',
        error: 'acme.com changed hands while you were looking. Check it again before reassigning.',
      });
      setup();
      await triggerConflict();
      type('Reason', 'x');
      submit('Reassign to Acme');

      expect(await screen.findByText(/changed hands while you were looking/i)).toBeInTheDocument();
      expect(screen.queryByText('acme.com belongs to Globex')).not.toBeInTheDocument();
      expect(mockToastError).toHaveBeenCalled();
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    it('announces the conflict politely and moves focus to the reason field', async () => {
      setup();
      await triggerConflict();

      expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
        'acme.com belongs to Globex. The button now reads Reassign to Acme.'
      );
      await waitFor(() => expect(screen.getByLabelText('Reason')).toHaveFocus());
    });
  });

  it('clears the previous status line when a submit starts', async () => {
    mockAdd.mockResolvedValue({ success: true, message: 'm' });
    const { onBegin } = setup();
    type('Domain', 'acme.com');
    submit('Add domain');
    await waitFor(() => expect(onBegin).toHaveBeenCalledTimes(1));
  });

  it('reports an unexpected rejection to Sentry and toasts a generic error', async () => {
    mockAdd.mockRejectedValue(new Error('network'));
    setup();
    type('Domain', 'acme.com');
    submit('Add domain');
    await waitFor(() =>
      expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ message: 'network' }))
    );
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining('Something went wrong'));
  });

  it('has no accessibility violations', async () => {
    const { container } = setup();
    expect(await axe(container)).toHaveNoViolations();
  });
});
