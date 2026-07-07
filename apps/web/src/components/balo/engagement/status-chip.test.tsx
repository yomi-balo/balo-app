import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';

import { StatusChip } from './status-chip';
import type { StatusChipView } from '@/lib/engagement/engagement-view';

const chip = (overrides: Partial<StatusChipView> = {}): StatusChipView => ({
  status: 'active',
  label: 'Active',
  tone: 'success',
  icon: 'Layers',
  ...overrides,
});

describe('StatusChip', () => {
  it('renders the active status with the success tone', () => {
    const { container } = render(<StatusChip status={chip()} />);
    const badge = screen.getByText('Active');
    expect(badge).toBeInTheDocument();
    expect(container.querySelector('[data-slot="badge"]')).toHaveClass('text-success');
  });

  it('renders the "Awaiting client review" label for pending_acceptance with the warning tone', () => {
    const { container } = render(
      <StatusChip
        status={chip({
          status: 'pending_acceptance',
          label: 'Awaiting client review',
          tone: 'warning',
          icon: 'Clock',
        })}
      />
    );
    expect(screen.getByText('Awaiting client review')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="badge"]')).toHaveClass('text-warning');
  });

  it('renders the completed status', () => {
    const { container } = render(
      <StatusChip status={chip({ status: 'completed', label: 'Completed', icon: 'Check' })} />
    );
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="badge"]')).toHaveClass('text-success');
  });

  it('renders the cancelled status with the destructive tone', () => {
    const { container } = render(
      <StatusChip
        status={chip({
          status: 'cancelled',
          label: 'Cancelled',
          tone: 'destructive',
          icon: 'Ban',
        })}
      />
    );
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(container.querySelector('[data-slot="badge"]')).toHaveClass('text-destructive');
  });

  it('maps the neutral tone to muted classes', () => {
    const { container } = render(<StatusChip status={chip({ tone: 'neutral' })} />);
    expect(container.querySelector('[data-slot="badge"]')).toHaveClass('text-muted-foreground');
  });
});
