import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockCloseAdminAlert = vi.fn();
vi.mock('../_actions/close-admin-alert', () => ({
  closeAdminAlert: (...a: unknown[]) => mockCloseAdminAlert(...a),
}));

const mockLoadMoreAdminAlerts = vi.fn();
vi.mock('../_actions/load-more-admin-alerts', () => ({
  loadMoreAdminAlerts: (...a: unknown[]) => mockLoadMoreAdminAlerts(...a),
}));

import { AlertQueue } from './alert-queue';
import { toast } from 'sonner';
import type { AdminQueueRowView } from '../_lib/admin-queue-view';

function row(id: string, overrides: Partial<AdminQueueRowView> = {}): AdminQueueRowView {
  return {
    id,
    kind: 'expert.application_pending',
    group: 'marketplace',
    entityType: 'expert',
    title: `Row ${id}`,
    entityLabel: `Person ${id}`,
    entityHead: `Person ${id}`,
    evidence: 'evidence',
    facts: [],
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
    target: { label: 'the application', href: `/admin/applications/${id}` },
    cursor: { firstSeenAtIso: '2026-09-05T12:00:00.000Z', id },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AlertQueue', () => {
  it('renders the initial rows and no "Load more" button when there is no more', () => {
    render(
      <AlertQueue
        initialRows={[row('a'), row('b')]}
        initialHasMore={false}
        initialCursor={null}
        kinds={undefined}
        canResolve
        initialOpenId={null}
      />
    );
    expect(screen.getByText('Row a')).toBeInTheDocument();
    expect(screen.getByText('Row b')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument();
  });

  it('expands the row named by initialOpenId (from ?open=) on first render', () => {
    render(
      <AlertQueue
        initialRows={[row('a'), row('b')]}
        initialHasMore={false}
        initialCursor={null}
        kinds={undefined}
        canResolve
        initialOpenId="b"
      />
    );
    const rowB = screen.getByText('Row b').closest('[role="button"]');
    expect(rowB).toHaveAttribute('aria-expanded', 'true');
  });

  it('one-expanded-at-a-time: expanding a second row collapses the first', async () => {
    const user = userEvent.setup();
    render(
      <AlertQueue
        initialRows={[row('a'), row('b')]}
        initialHasMore={false}
        initialCursor={null}
        kinds={undefined}
        canResolve
        initialOpenId={null}
      />
    );
    const rowAToggle = screen.getByText('Row a').closest('[role="button"]');
    const rowBToggle = screen.getByText('Row b').closest('[role="button"]');
    expect(rowAToggle).not.toBeNull();
    expect(rowBToggle).not.toBeNull();
    if (rowAToggle === null || rowBToggle === null) return;

    await user.click(rowAToggle);
    expect(rowAToggle).toHaveAttribute('aria-expanded', 'true');

    await user.click(rowBToggle);
    expect(rowAToggle).toHaveAttribute('aria-expanded', 'false');
    expect(rowBToggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('removes a row from the list once its close succeeds', async () => {
    mockCloseAdminAlert.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(
      <AlertQueue
        initialRows={[row('a', { selfCloses: false, noteCloseable: true })]}
        initialHasMore={false}
        initialCursor={null}
        kinds={undefined}
        canResolve
        initialOpenId="a"
      />
    );
    await user.click(screen.getByRole('button', { name: /Close with a note/ }));
    await user.type(
      screen.getByPlaceholderText(/What was done, and why this can close/),
      'Refunded manually via Stripe'
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.queryByText('Row a')).not.toBeInTheDocument();
  });

  it('loads more rows, appends them, and updates hasMore/cursor', async () => {
    mockLoadMoreAdminAlerts.mockResolvedValue({
      success: true,
      rows: [row('c')],
      hasMore: false,
      nextCursor: null,
    });
    const user = userEvent.setup();
    render(
      <AlertQueue
        initialRows={[row('a')]}
        initialHasMore
        initialCursor={{ firstSeenAtIso: '2026-09-05T12:00:00.000Z', id: 'a' }}
        kinds={['expert.application_pending']}
        canResolve
        initialOpenId={null}
      />
    );
    await user.click(screen.getByRole('button', { name: /Load more/ }));

    expect(mockLoadMoreAdminAlerts).toHaveBeenCalledWith({
      kinds: ['expert.application_pending'],
      afterFirstSeenAtIso: '2026-09-05T12:00:00.000Z',
      afterId: 'a',
    });
    expect(await screen.findByText('Row c')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument();
  });

  it('toasts an error and keeps the existing rows when Load more fails', async () => {
    mockLoadMoreAdminAlerts.mockResolvedValue({
      success: false,
      error: 'Could not load more. Try again in a moment.',
    });
    const user = userEvent.setup();
    render(
      <AlertQueue
        initialRows={[row('a')]}
        initialHasMore
        initialCursor={{ firstSeenAtIso: '2026-09-05T12:00:00.000Z', id: 'a' }}
        kinds={undefined}
        canResolve
        initialOpenId={null}
      />
    );
    await user.click(screen.getByRole('button', { name: /Load more/ }));

    expect(toast.error).toHaveBeenCalledWith('Could not load more. Try again in a moment.');
    expect(screen.getByText('Row a')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Load more/ })).toBeInTheDocument();
  });
});
