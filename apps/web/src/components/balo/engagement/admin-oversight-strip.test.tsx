import { describe, it, expect, vi } from 'vitest';

import { render, screen } from '@/test/utils';
import type { AdminOversightView } from '@/lib/engagement/engagement-view';

// AdminOversightStrip now renders the AdminCancelButton island (hook + cancel
// Server Action). Mock the router/toast and the action module so this test doesn't
// pull @balo/db.
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/cancel-engagement', () => ({
  cancelEngagementAction: vi.fn(),
}));

import { AdminOversightStrip } from './admin-oversight-strip';

const healthy: AdminOversightView = {
  lastActivityLabel: 'Last delivery activity: 2d ago',
  stalled: false,
  stalledNote: null,
};

const stalled: AdminOversightView = {
  lastActivityLabel: 'Last delivery activity: 16d ago',
  stalled: true,
  stalledNote: 'Nothing has started since kickoff. Worth a check-in with Priya.',
};

describe('AdminOversightStrip', () => {
  it('renders the oversight label and last-activity pill', () => {
    render(<AdminOversightStrip oversight={healthy} engagementId="eng-1" />);
    expect(screen.getByText('Oversight')).toBeInTheDocument();
    expect(screen.getByText('Last delivery activity: 2d ago')).toBeInTheDocument();
  });

  it('does not render the stalled pill or note when not stalled', () => {
    render(<AdminOversightStrip oversight={healthy} engagementId="eng-1" />);
    expect(screen.queryByText('Stalled')).not.toBeInTheDocument();
  });

  it('renders the stalled pill and note when stalled', () => {
    render(<AdminOversightStrip oversight={stalled} engagementId="eng-1" />);
    expect(screen.getByText('Stalled')).toBeInTheDocument();
    expect(screen.getByText(/Nothing has started since kickoff/)).toBeInTheDocument();
  });

  it('renders the "Cancel engagement" danger action (D4)', () => {
    render(<AdminOversightStrip oversight={stalled} engagementId="eng-1" />);
    expect(screen.getByRole('button', { name: /Cancel engagement/i })).toBeInTheDocument();
  });
});
