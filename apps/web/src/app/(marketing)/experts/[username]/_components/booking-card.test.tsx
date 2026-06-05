import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { track, EXPERT_PROFILE_EVENTS } from '@/lib/analytics';

import { BookingCard } from './booking-card';

const mockTrack = vi.mocked(track);

function renderCard(overrides: Partial<Parameters<typeof BookingCard>[0]> = {}) {
  const props = {
    expertId: 'expert-1',
    rate: 9.5,
    availableForWork: true,
    onBook: vi.fn(),
    onStartProject: vi.fn(),
    onMessage: vi.fn(),
    ...overrides,
  };
  const result = render(<BookingCard {...props} />);
  return { ...result, props };
}

describe('BookingCard', () => {
  beforeEach(() => {
    mockTrack.mockClear();
  });

  it('renders the per-minute rate when a rate is set', () => {
    renderCard({ rate: 9.5 });
    expect(screen.getByText('A$9.50')).toBeInTheDocument();
    expect(screen.getByText('/ min')).toBeInTheDocument();
  });

  it('renders "Rate on request" when the rate is null', () => {
    renderCard({ rate: null });
    expect(screen.getByText('Rate on request')).toBeInTheDocument();
    expect(screen.queryByText('/ min')).not.toBeInTheDocument();
  });

  it('fires a cta_impression for each CTA on mount', () => {
    renderCard();
    const ctas = mockTrack.mock.calls
      .filter(([event]) => event === EXPERT_PROFILE_EVENTS.PROFILE_CTA_IMPRESSION)
      .map(([, props]) => (props as { cta: string }).cta);
    expect(ctas).toEqual(['book', 'project', 'message']);
    expect(mockTrack).toHaveBeenCalledWith(EXPERT_PROFILE_EVENTS.PROFILE_CTA_IMPRESSION, {
      expert_id: 'expert-1',
      cta: 'book',
    });
  });

  it('calls the stub handlers when CTAs are clicked', async () => {
    const user = userEvent.setup();
    const { props } = renderCard();

    await user.click(screen.getByRole('button', { name: /book a consultation/i }));
    expect(props.onBook).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /start a project/i }));
    expect(props.onStartProject).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /send a message first/i }));
    expect(props.onMessage).toHaveBeenCalledTimes(1);
  });

  it('shows the unavailable state when not available for work', () => {
    renderCard({ availableForWork: false });
    expect(screen.getByText('Currently unavailable')).toBeInTheDocument();
  });

  it('drives position/order via CSS responsive utilities on the card root (no JS branch)', () => {
    const { container } = renderCard();
    const root = container.firstElementChild as HTMLElement;
    // Mobile-first: order-first + relative at first paint (no hydration jump).
    expect(root.className).toContain('order-first');
    expect(root.className).toContain('relative');
    // ≥820px: normal order + sticky, gated on the custom breakpoint.
    expect(root.className).toContain('min-[820px]:order-none');
    expect(root.className).toContain('min-[820px]:sticky');
    expect(root.className).toContain('min-[820px]:top-28');
  });

  it('puts the position classes on the card root itself — no wrapper element', () => {
    const { container } = renderCard();
    // The single rendered root IS the positioned element (sticky depends on it
    // being a direct grid child); it must not be a bare wrapper around a card.
    expect(container.childElementCount).toBe(1);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('order-first');
    // First child of the root is the rate Card, not another positioned wrapper.
    expect(root.firstElementChild?.className ?? '').not.toContain('order-first');
  });

  it('has no accessibility violations', async () => {
    const { container } = renderCard();
    expect(await axe(container)).toHaveNoViolations();
  });
});
