import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { track, WALLET_EVENTS } from '@/lib/analytics';
import { CreditsChip, CreditsChipSkeleton } from './credits-chip';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CreditsChip — holder lens', () => {
  it('renders the balance and the inline Top-up affordance, linking to /billing/top-up', () => {
    render(<CreditsChip balanceMinor={42_000} canTopUp />);

    expect(screen.getByText('A$420.00')).toBeInTheDocument();
    expect(screen.getByText('Top up')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /credits/i });
    expect(link).toHaveAttribute('href', '/billing/top-up');
    expect(link).toHaveAccessibleName('Credits: A$420.00 — top up');
  });

  it.each([
    [0, 'zero'],
    [4_999, 'low'],
    [5_000, 'healthy'],
  ] as const)('balanceMinor %i resolves to the %s band on click', async (balanceMinor, state) => {
    const user = userEvent.setup();
    render(<CreditsChip balanceMinor={balanceMinor} canTopUp />);

    await user.click(screen.getByRole('link', { name: /credits/i }));

    expect(track).toHaveBeenCalledWith(WALLET_EVENTS.CHIP_CLICKED, { lens: 'holder', state });
  });

  it('the click payload carries ONLY lens and state — never the exact amount', async () => {
    const user = userEvent.setup();
    render(<CreditsChip balanceMinor={42_000} canTopUp />);

    await user.click(screen.getByRole('link', { name: /credits/i }));

    expect(track).toHaveBeenCalledWith(WALLET_EVENTS.CHIP_CLICKED, {
      lens: 'holder',
      state: 'healthy',
    });
  });
});

describe('CreditsChip — member lens', () => {
  it('renders the same balance without the Top-up word, same destination', () => {
    render(<CreditsChip balanceMinor={42_000} canTopUp={false} />);

    expect(screen.getByText('A$420.00')).toBeInTheDocument();
    expect(screen.queryByText('Top up')).not.toBeInTheDocument();
    const link = screen.getByRole('link', { name: /credits/i });
    expect(link).toHaveAttribute('href', '/billing/top-up');
    expect(link).toHaveAccessibleName('Credits: A$420.00 — view credits');
  });

  it('fires the click event with lens: member', async () => {
    const user = userEvent.setup();
    render(<CreditsChip balanceMinor={1_000} canTopUp={false} />);

    await user.click(screen.getByRole('link', { name: /credits/i }));

    expect(track).toHaveBeenCalledWith(WALLET_EVENTS.CHIP_CLICKED, {
      lens: 'member',
      state: 'low',
    });
  });
});

describe('CreditsChipSkeleton', () => {
  it('renders and is aria-hidden', () => {
    const { container } = render(<CreditsChipSkeleton />);
    const skeleton = container.firstChild;
    expect(skeleton).toHaveAttribute('aria-hidden', 'true');
  });

  it('BAL-499 F4: matches the real chip’s frame (height, padding, border, radius) so only the inner content resolves', () => {
    const { container: skeletonContainer } = render(<CreditsChipSkeleton />);
    const { container: chipContainer } = render(<CreditsChip balanceMinor={42_000} canTopUp />);
    const skeleton = skeletonContainer.firstChild as HTMLElement;
    const chip = chipContainer.firstChild as HTMLElement;

    for (const frameClass of ['h-8', 'rounded-lg', 'border-border', 'bg-card', 'px-2.5']) {
      expect(skeleton.className).toContain(frameClass);
      expect(chip.className).toContain(frameClass);
    }
  });

  it('BAL-499 F4: is not a single flat box — it carries icon + balance + "Top up" placeholders sized to typical content', () => {
    const { container } = render(<CreditsChipSkeleton />);
    // Three placeholder bars (icon dot, balance, "Top up"), not the old single `w-28` blob.
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(3);
  });
});

describe('accessibility', () => {
  it('CreditsChip has no accessibility violations', async () => {
    const { container } = render(<CreditsChip balanceMinor={42_000} canTopUp />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
