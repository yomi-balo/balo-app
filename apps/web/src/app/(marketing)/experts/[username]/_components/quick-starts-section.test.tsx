import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { QuickStartSummary } from '@/components/expert/profile';
import { QuickStartsSection } from './quick-starts-section';

/**
 * In v1 the profile always passes `packages={[]}`, so the empty branch is the
 * live path — it must read as an invitation (BAL-257), never as absence. The
 * populated branch is the BAL-255 seam; it's exercised here so the reframed
 * intro and the `PackageCard` map stay covered.
 */
const PKG: QuickStartSummary = {
  id: 'pkg-1',
  title: 'Flow Audit',
  priceLabel: 'A$450',
  durationLabel: '1–2 days',
  description: 'A focused review of your automation.',
};

describe('QuickStartsSection — empty state', () => {
  it('leads with an invitation, not absence-framed copy', () => {
    render(<QuickStartsSection packages={[]} firstName="Priya" onStartProject={vi.fn()} />);

    expect(screen.getByText('Start a project with Priya')).toBeInTheDocument();
    // The reframe must not define the section by what's missing.
    expect(screen.queryByText(/no .* yet/i)).not.toBeInTheDocument();
  });

  it('fires the existing handler when the CTA is clicked', async () => {
    const user = userEvent.setup();
    const onStartProject = vi.fn();
    render(<QuickStartsSection packages={[]} firstName="Priya" onStartProject={onStartProject} />);

    await user.click(screen.getByRole('button', { name: /start a project/i }));
    expect(onStartProject).toHaveBeenCalledTimes(1);
  });
});

describe('QuickStartsSection — populated state', () => {
  it('renders package cards and the buy-in-a-click intro, not the empty invitation', () => {
    render(
      <QuickStartsSection
        packages={[PKG]}
        firstName="Priya"
        onStartProject={vi.fn()}
        onViewDetails={vi.fn()}
      />
    );

    expect(screen.getByText('Flow Audit')).toBeInTheDocument();
    expect(screen.getByText(/buy in a click/i)).toBeInTheDocument();
    expect(screen.queryByText('Start a project with Priya')).not.toBeInTheDocument();
  });

  it('calls onViewDetails with the package id when a card is opened', async () => {
    const user = userEvent.setup();
    const onViewDetails = vi.fn();
    render(
      <QuickStartsSection
        packages={[PKG]}
        firstName="Priya"
        onStartProject={vi.fn()}
        onViewDetails={onViewDetails}
      />
    );

    await user.click(screen.getByRole('button', { name: /flow audit/i }));
    expect(onViewDetails).toHaveBeenCalledWith('pkg-1');
  });
});
