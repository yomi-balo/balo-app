import { describe, it, expect } from 'vitest';

import { render, screen } from '@/test/utils';
import type { AdminOversightView } from '@/lib/engagement/engagement-view';

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
    render(<AdminOversightStrip oversight={healthy} />);
    expect(screen.getByText('Oversight')).toBeInTheDocument();
    expect(screen.getByText('Last delivery activity: 2d ago')).toBeInTheDocument();
  });

  it('does not render the stalled pill or note when not stalled', () => {
    render(<AdminOversightStrip oversight={healthy} />);
    expect(screen.queryByText('Stalled')).not.toBeInTheDocument();
  });

  it('renders the stalled pill and note when stalled', () => {
    render(<AdminOversightStrip oversight={stalled} />);
    expect(screen.getByText('Stalled')).toBeInTheDocument();
    expect(screen.getByText(/Nothing has started since kickoff/)).toBeInTheDocument();
  });

  it('renders no cancel button (read-only)', () => {
    render(<AdminOversightStrip oversight={stalled} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
