import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { QuickStartSummary } from '@/components/expert/profile';
import { PackageCard } from './package-card';

/**
 * `PackageCard` is the BAL-255 seam — not mounted in v1 (the profile passes
 * `packages={[]}`), so it needs a direct test. It renders the package summary
 * and invokes `onViewDetails(pkg.id)` on click.
 */
const PKG: QuickStartSummary = {
  id: 'pkg-1',
  title: 'Flow Audit',
  priceLabel: 'A$450',
  durationLabel: '1–2 days',
  description: 'A focused review of your automation.',
};

describe('PackageCard', () => {
  it('renders the package title, price, duration, and description', () => {
    render(<PackageCard pkg={PKG} onViewDetails={vi.fn()} />);
    expect(screen.getByText('Flow Audit')).toBeInTheDocument();
    expect(screen.getByText('A$450')).toBeInTheDocument();
    expect(screen.getByText('1–2 days')).toBeInTheDocument();
    expect(screen.getByText('A focused review of your automation.')).toBeInTheDocument();
  });

  it('calls onViewDetails with the package id when clicked', async () => {
    const user = userEvent.setup();
    const onViewDetails = vi.fn();
    render(<PackageCard pkg={PKG} onViewDetails={onViewDetails} />);
    await user.click(screen.getByRole('button'));
    expect(onViewDetails).toHaveBeenCalledWith('pkg-1');
  });
});
