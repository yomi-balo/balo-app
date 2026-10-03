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
    firstName: 'Anil',
    verticalName: 'Salesforce',
    similarExpertsHref: '/experts?timeframe=week&sort=soonest',
    onBook: vi.fn(),
    onStartProject: vi.fn(),
    onGetMatched: vi.fn(),
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

  describe('paused (not available for work)', () => {
    it('never renders a Book button, the project CTA or the "first" message link', () => {
      renderCard({ availableForWork: false });
      expect(
        screen.queryByRole('button', { name: /book a consultation/i })
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^start a project/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/send a message first/i)).not.toBeInTheDocument();
    });

    it('states the pause with the expert first name and vertical', () => {
      renderCard({ availableForWork: false, firstName: 'Priya', verticalName: 'Workday' });
      expect(screen.getByText('Not taking on new work right now')).toBeInTheDocument();
      expect(screen.getByText("Priya isn't taking on new work right now.")).toBeInTheDocument();
      expect(
        screen.getByText('We can introduce you to someone with similar Workday experience.')
      ).toBeInTheDocument();
    });

    it('offers Find a similar expert as a link to the supplied search href', () => {
      renderCard({ availableForWork: false, similarExpertsHref: '/experts?vertical=x' });
      expect(screen.getByRole('link', { name: /find a similar expert/i })).toHaveAttribute(
        'href',
        '/experts?vertical=x'
      );
    });

    it('wires Get matched and the message link, and tracks the find_similar click', async () => {
      const user = userEvent.setup();
      const { props } = renderCard({ availableForWork: false });

      await user.click(screen.getByRole('button', { name: /get matched for a project/i }));
      expect(props.onGetMatched).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole('button', { name: /send anil a message/i }));
      expect(props.onMessage).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole('link', { name: /find a similar expert/i }));
      expect(mockTrack).toHaveBeenCalledWith(EXPERT_PROFILE_EVENTS.PROFILE_CTA_CLICKED, {
        expert_id: 'expert-1',
        cta: 'find_similar',
      });
    });

    it('fires the three paused impressions plus booking_unavailable_shown, once', () => {
      const { rerender, props } = renderCard({ availableForWork: false });
      rerender(<BookingCard {...props} />);
      const impressions = mockTrack.mock.calls
        .filter(([event]) => event === EXPERT_PROFILE_EVENTS.PROFILE_CTA_IMPRESSION)
        .map(([, payload]) => (payload as { cta: string }).cta);
      expect(impressions).toEqual(['find_similar', 'match_project', 'message']);
      const shown = mockTrack.mock.calls.filter(
        ([event]) => event === EXPERT_PROFILE_EVENTS.BOOKING_UNAVAILABLE_SHOWN
      );
      expect(shown).toEqual([
        [EXPERT_PROFILE_EVENTS.BOOKING_UNAVAILABLE_SHOWN, { expert_id: 'expert-1' }],
      ]);
    });

    it('does not fire booking_unavailable_shown for an available expert', () => {
      renderCard();
      expect(mockTrack).not.toHaveBeenCalledWith(
        EXPERT_PROFILE_EVENTS.BOOKING_UNAVAILABLE_SHOWN,
        expect.anything()
      );
    });

    it('keeps the order-first mobile position and the rate header', () => {
      const { container } = renderCard({ availableForWork: false, rate: 9.5 });
      expect((container.firstElementChild as HTMLElement).className).toContain('order-first');
      expect(screen.getByText('A$9.50')).toBeInTheDocument();
    });

    it('has no accessibility violations', async () => {
      const { container } = renderCard({ availableForWork: false });
      expect(await axe(container)).toHaveNoViolations();
    });
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
