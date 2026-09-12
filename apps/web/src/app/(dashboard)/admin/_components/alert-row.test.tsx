import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/utils';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockCloseAdminAlert = vi.fn();
vi.mock('../_actions/close-admin-alert', () => ({
  closeAdminAlert: (...a: unknown[]) => mockCloseAdminAlert(...a),
}));

import { AlertRow } from './alert-row';
import { toast } from 'sonner';
import { track, ADMIN_ALERTS_EVENTS } from '@/lib/analytics';
import type { AdminQueueRowView } from '../_lib/admin-queue-view';

function row(overrides: Partial<AdminQueueRowView> = {}): AdminQueueRowView {
  return {
    id: 'alert-1',
    kind: 'expert.application_pending',
    group: 'marketplace',
    entityType: 'expert',
    title: 'An application is waiting on review',
    entityLabel: 'Priya Nair @ CloudPeak',
    entityHead: 'Priya Nair',
    evidence: 'Submitted 3 days ago, no reviewer assigned.',
    facts: [['Submitted', '3d ago']],
    money: null,
    moneyConcealed: false,
    occurrences: 1,
    firstSeenAtIso: '2026-09-05T12:00:00.000Z',
    ageLabel: '3d',
    ageDays: 3,
    ageEmphasised: true,
    closes: 'Closes itself once the application is approved or rejected',
    selfCloses: true,
    noteCloseable: false,
    // BAL-549 re-point — the id-keyed application review page, not the /admin/catalogue fallback.
    target: { label: 'the application', href: '/admin/applications/expert-profile-1' },
    cursor: { firstSeenAtIso: '2026-09-05T12:00:00.000Z', id: 'alert-1' },
    ...overrides,
  };
}

const noop = (): void => undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AlertRow', () => {
  it('renders the sentence, entity, evidence, and "first seen" meta', () => {
    render(
      <AlertRow
        row={row()}
        index={0}
        last
        expanded={false}
        onToggle={noop}
        canResolve
        onClosed={noop}
      />
    );
    expect(screen.getByText('An application is waiting on review')).toBeInTheDocument();
    expect(screen.getByText('Priya Nair @ CloudPeak')).toBeInTheDocument();
    expect(screen.getByText(/Submitted 3 days ago/)).toBeInTheDocument();
    expect(screen.getByText(/First seen 3d ago/)).toBeInTheDocument();
  });

  it('shows "raised N×" only when occurrences > 1', () => {
    const { rerender } = render(
      <AlertRow
        row={row({ occurrences: 1 })}
        index={0}
        last
        expanded={false}
        onToggle={noop}
        canResolve
        onClosed={noop}
      />
    );
    expect(screen.queryByText(/raised/)).not.toBeInTheDocument();

    rerender(
      <AlertRow
        row={row({ occurrences: 3 })}
        index={0}
        last
        expanded={false}
        onToggle={noop}
        canResolve
        onClosed={noop}
      />
    );
    expect(screen.getByText('raised 3×')).toBeInTheDocument();
  });

  it('toggles expansion on click and on Enter/Space', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <AlertRow
        row={row()}
        index={0}
        last
        expanded={false}
        onToggle={onToggle}
        canResolve
        onClosed={noop}
      />
    );
    await user.click(screen.getByRole('button', { expanded: false }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    // `fireEvent.keyDown` (not `userEvent.type`) — userEvent v14 simulates the browser's
    // native <button> "Enter fires a click" behaviour for ANY role="button" element, which
    // double-counts against this component's own onKeyDown handler. Dispatching the raw
    // keydown event is what actually exercises that handler in isolation.
    fireEvent.keyDown(screen.getByRole('button', { expanded: false }), { key: 'Enter' });
    expect(onToggle).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(screen.getByRole('button', { expanded: false }), { key: ' ' });
    expect(onToggle).toHaveBeenCalledTimes(3);
  });

  it('renders facts, the Open link, and no close affordance for a self-closing (finder) kind', () => {
    render(
      <AlertRow row={row()} index={0} last expanded onToggle={noop} canResolve onClosed={noop} />
    );
    expect(screen.getByText('Submitted')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the application/ })).toHaveAttribute(
      'href',
      '/admin/applications/expert-profile-1'
    );
    expect(
      screen.getByText(/No manual close — a sweep closes this when the condition clears\./)
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Close with a note/ })).not.toBeInTheDocument();
  });

  it('shows "Close with a note" for a no-finder kind, disabled without RESOLVE_ADMIN_ALERTS', () => {
    render(
      <AlertRow
        row={row({
          selfCloses: false,
          noteCloseable: true,
          closes: 'No row to re-check — closes with a note once recovered or written off',
        })}
        index={0}
        last
        expanded
        onToggle={noop}
        canResolve={false}
        onClosed={noop}
      />
    );
    const closeButton = screen.getByRole('button', { name: /Close with a note/ });
    expect(closeButton).toBeDisabled();
    expect(closeButton).toHaveAttribute('title', 'Closing needs the resolve-alerts capability');
  });

  it('closes with a note: disables Close until 8+ chars, calls the action, toasts, and calls onClosed', async () => {
    mockCloseAdminAlert.mockResolvedValue({ success: true });
    const onClosed = vi.fn();
    const user = userEvent.setup();
    render(
      <AlertRow
        row={row({ selfCloses: false, noteCloseable: true })}
        index={0}
        last
        expanded
        onToggle={noop}
        canResolve
        onClosed={onClosed}
      />
    );
    await user.click(screen.getByRole('button', { name: /Close with a note/ }));
    const textarea = screen.getByPlaceholderText(/What was done, and why this can close/);
    const closeSubmit = screen.getByRole('button', { name: 'Close' });
    expect(closeSubmit).toBeDisabled();

    await user.type(textarea, 'Refunded manually via Stripe');
    expect(closeSubmit).not.toBeDisabled();

    await user.click(closeSubmit);
    expect(mockCloseAdminAlert).toHaveBeenCalledWith({
      alertId: 'alert-1',
      note: 'Refunded manually via Stripe',
    });
    expect(toast.success).toHaveBeenCalledWith('Closed — the note is on the record.');
    expect(onClosed).toHaveBeenCalledWith('alert-1');
  });

  it('toasts the server error and does not call onClosed on a refused close', async () => {
    mockCloseAdminAlert.mockResolvedValue({
      success: false,
      reason: 'finder_kind',
      error: 'This one closes itself — the next sweep will clear it once the condition is gone.',
    });
    const onClosed = vi.fn();
    const user = userEvent.setup();
    render(
      <AlertRow
        row={row({ selfCloses: false, noteCloseable: true })}
        index={0}
        last
        expanded
        onToggle={noop}
        canResolve
        onClosed={onClosed}
      />
    );
    await user.click(screen.getByRole('button', { name: /Close with a note/ }));
    await user.type(
      screen.getByPlaceholderText(/What was done, and why this can close/),
      'Refunded manually'
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(toast.error).toHaveBeenCalledWith(
      'This one closes itself — the next sweep will clear it once the condition is gone.'
    );
    expect(onClosed).not.toHaveBeenCalled();
    // BAL-548 — a refused close is not a close; the analytics event must not fire either.
    expect(track).not.toHaveBeenCalledWith(ADMIN_ALERTS_EVENTS.ALERT_CLOSED, expect.anything());
  });

  it('renders the money block, showing the lock affordance for concealed fields', () => {
    render(
      <AlertRow
        row={row({
          money: { client: 'A$500.00', expert: null, margin: null, markup: null },
          moneyConcealed: true,
        })}
        index={0}
        last
        expanded
        onToggle={noop}
        canResolve
        onClosed={noop}
      />
    );
    expect(screen.getByText('A$500.00')).toBeInTheDocument();
    expect(screen.getAllByText('Needs fee visibility')).toHaveLength(2);
    expect(
      screen.getByText(
        /Expert earnings and margin render only for holders of MANAGE_PLATFORM_FEES\./
      )
    ).toBeInTheDocument();
  });

  it('renders full money values for a viewer with fee visibility', () => {
    render(
      <AlertRow
        row={row({
          money: { client: 'A$500.00', expert: 'A$400.00', margin: 'A$100.00', markup: '25%' },
          moneyConcealed: false,
        })}
        index={0}
        last
        expanded
        onToggle={noop}
        canResolve
        onClosed={noop}
      />
    );
    expect(screen.getByText('A$400.00')).toBeInTheDocument();
    expect(screen.getByText('A$100.00 (25% markup)')).toBeInTheDocument();
    expect(screen.queryByText('Needs fee visibility')).not.toBeInTheDocument();
  });

  it('BAL-548: clicking Open fires admin_alert_opened with the kind and age bucket', async () => {
    const user = userEvent.setup();
    render(
      <AlertRow row={row()} index={0} last expanded onToggle={noop} canResolve onClosed={noop} />
    );
    await user.click(screen.getByRole('link', { name: /Open the application/ }));
    expect(track).toHaveBeenCalledWith(ADMIN_ALERTS_EVENTS.ALERT_OPENED, {
      kind: 'expert.application_pending',
      age_bucket: '3_7d',
    });
  });

  it('BAL-548: a successful close fires admin_alert_closed with the kind and age bucket', async () => {
    mockCloseAdminAlert.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(
      <AlertRow
        row={row({ selfCloses: false, noteCloseable: true, ageDays: 8 })}
        index={0}
        last
        expanded
        onToggle={noop}
        canResolve
        onClosed={noop}
      />
    );
    await user.click(screen.getByRole('button', { name: /Close with a note/ }));
    await user.type(
      screen.getByPlaceholderText(/What was done, and why this can close/),
      'Refunded manually via Stripe'
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(track).toHaveBeenCalledWith(ADMIN_ALERTS_EVENTS.ALERT_CLOSED, {
      kind: 'expert.application_pending',
      age_bucket: 'over_7d',
    });
  });
});
