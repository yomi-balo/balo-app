import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import type { BookIntroCallResult } from '@/lib/booking/actions/book-intro-call-types';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const { mockIsMobile } = vi.hoisted(() => ({ mockIsMobile: vi.fn(() => false) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mockIsMobile() }));

const { mockOnSlotSelect } = vi.hoisted(() => ({ mockOnSlotSelect: vi.fn() }));
vi.mock('@/components/availability', () => ({
  ExpertAvailabilityCalendar: (props: {
    onSlotSelect?: (s: { start: string; end: string; duration: 15 | 30 | 45 | 60 }) => void;
    emptyAction?: React.ReactNode;
  }) => {
    mockOnSlotSelect.mockImplementation(() =>
      props.onSlotSelect?.({
        start: '2026-06-05T09:00:00.000Z',
        end: '2026-06-05T09:30:00.000Z',
        duration: 30,
      })
    );
    return (
      <div>
        <button type="button" onClick={() => mockOnSlotSelect()}>
          Pick 9am slot
        </button>
        {props.emptyAction}
      </div>
    );
  },
}));

const mockBookIntroCallAction = vi.fn<(input: unknown) => Promise<BookIntroCallResult>>();
vi.mock('@/lib/booking/actions/book-intro-call', () => ({
  bookIntroCallAction: (input: unknown) => mockBookIntroCallAction(input),
}));

vi.mock('@/lib/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/analytics')>()),
  track: vi.fn(),
}));

import { IntroCallBookingDialog } from './intro-call-booking-dialog';

function successResult(overrides: Partial<Extract<BookIntroCallResult, { ok: true }>> = {}) {
  return {
    ok: true as const,
    meetingId: 'meeting-1',
    joinPath: '/join/m/meeting-1',
    provisioned: true,
    scheduledStartIso: '2026-06-05T09:00:00.000Z',
    scheduledEndIso: '2026-06-05T09:30:00.000Z',
    durationMinutes: 30,
    guestsInvited: 0,
    guestInviteFailed: false,
    ...overrides,
  };
}

function renderDialog(overrides: Record<string, unknown> = {}) {
  const onOpenChange = vi.fn();
  const onBooked = vi.fn();
  const onMessage = vi.fn();
  const rendered = render(
    <IntroCallBookingDialog
      open
      onOpenChange={onOpenChange}
      requestId="request-1"
      relationshipId="rel-1"
      expertProfileId="expert-1"
      expertName="Priya Nair"
      expertFirstName="Priya"
      expertInitials="PN"
      requestTitle="CPQ implementation"
      clientCompanyName="Northwind Industrial"
      viewerEmailDomain="northwind.example"
      viewerTimezone="UTC"
      surface="header"
      onBooked={onBooked}
      onMessage={onMessage}
      {...overrides}
    />
  );
  return { ...rendered, onOpenChange, onBooked, onMessage };
}

async function advanceToConfirm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Pick 9am slot' }));
}

beforeEach(() => {
  mockBookIntroCallAction.mockReset();
  mockOnSlotSelect.mockReset();
  vi.mocked(toast.success).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('IntroCallBookingDialog', () => {
  it('opens to pick_time and advances to confirm on slot select', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getByText('Choose a time')).toBeInTheDocument();
    await advanceToConfirm(user);
    expect(screen.getByText(/Intro call for/)).toBeInTheDocument();
    expect(screen.getByText('CPQ implementation', { exact: false })).toBeInTheDocument();
  });

  it('confirm submits bookIntroCallAction with request_interaction shape and surface', async () => {
    const user = userEvent.setup();
    mockBookIntroCallAction.mockResolvedValue(successResult());
    renderDialog({ surface: 'nudge' });
    await advanceToConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Confirm & book call' }));

    expect(mockBookIntroCallAction).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'request-1',
        relationshipId: 'rel-1',
        slot: {
          startIso: '2026-06-05T09:00:00.000Z',
          endIso: '2026-06-05T09:30:00.000Z',
          durationMinutes: 30,
        },
        surface: 'nudge',
        guests: [],
      })
    );
  });

  it('a successful booking shows the booked step, fires analytics + toast, and calls onBooked', async () => {
    const user = userEvent.setup();
    mockBookIntroCallAction.mockResolvedValue(successResult());
    const { onBooked } = renderDialog();
    await advanceToConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Confirm & book call' }));

    expect(await screen.findByText("You're booked!")).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith(
      'conversation_intro_call_booked',
      expect.objectContaining({ request_id: 'request-1', relationship_id: 'rel-1' })
    );
    expect(toast.success).toHaveBeenCalled();
    // ⚠ round-1 C1: `onBooked` carries the booked snapshot so the CALLER can flip its own
    // thread state. A bare `() => void` left the caller with only `router.refresh()`, which
    // PRESERVES client component state — so the CTA never disappeared.
    expect(onBooked).toHaveBeenCalledWith({
      relationshipId: 'rel-1',
      meetingId: 'meeting-1',
      scheduledStartIso: '2026-06-05T09:00:00.000Z',
    });
  });

  it('slot_unavailable shows the StaleSlotBanner inline on confirm, preserving the picked slot', async () => {
    const user = userEvent.setup();
    mockBookIntroCallAction.mockResolvedValue({ ok: false, code: 'slot_unavailable' });
    renderDialog();
    await advanceToConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Confirm & book call' }));

    expect(
      await screen.findByText('This time was just booked by someone else.')
    ).toBeInTheDocument();
    // Still on the confirm step — the picked slot's context strip is still rendered.
    expect(screen.getByText(/Intro call for/)).toBeInTheDocument();
  });

  it('booking_failed shows the retryable panel — with NO "Nothing was charged" money framing', async () => {
    const user = userEvent.setup();
    mockBookIntroCallAction.mockResolvedValue({ ok: false, code: 'booking_failed' });
    renderDialog();
    await advanceToConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Confirm & book call' }));

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    // ⚠ round-1 W8: `HardFailurePanel`'s DEFAULT body says "Nothing was charged" — money framing
    // on a free call (Ruling 2), and a non-sequitur since nothing could have been charged.
    expect(screen.getByText(/Nothing was scheduled/)).toBeInTheDocument();
    expect(screen.queryByText(/charged/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  /**
   * ⚠ round-1 W9 — the client path used to collapse EVERY non-`slot_unavailable` failure into
   * the generic "Something went wrong · Try again", although `IntroCallBookingFailureCode`
   * distinguishes them and the design's edge-case table specifies distinct, NON-retry-inviting
   * copy. The EXPERT path already honoured this. `rate_limited` in particular offered a Retry
   * that was guaranteed to fail again.
   */
  it('not_permitted gets "This request has moved on" and NO retry affordance', async () => {
    const user = userEvent.setup();
    mockBookIntroCallAction.mockResolvedValue({ ok: false, code: 'not_permitted' });
    renderDialog();
    await advanceToConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Confirm & book call' }));

    expect(await screen.findByText('This request has moved on')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('rate_limited gets its own copy and no immediately-doomed retry', async () => {
    const user = userEvent.setup();
    mockBookIntroCallAction.mockResolvedValue({ ok: false, code: 'rate_limited' });
    renderDialog();
    await advanceToConfirm(user);
    await user.click(screen.getByRole('button', { name: 'Confirm & book call' }));

    expect(await screen.findByText('Too many booking attempts')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  /**
   * ⚠ THIS ASSERTION WAS VACUOUS (round-1 C3). It regexed `/per minute|\$\d|cancellation/i` —
   * none of which matched the words actually on screen, which were the guest composer's
   * "guests don't change what you PAY". A green that proves nothing is worse than no test, so
   * the vocabulary is now the MONEY vocabulary, asserted over the whole rendered text.
   */
  it('renders NO money vocabulary on the confirm step — Ruling 2', async () => {
    const user = userEvent.setup();
    const { baseElement } = renderDialog();
    await advanceToConfirm(user);

    const FREE_LINE = 'Free — no charge, no commitment.';
    expect(screen.getByText(FREE_LINE)).toBeInTheDocument();
    const text = (baseElement.textContent ?? '').replace(FREE_LINE, '');
    expect(text).not.toMatch(/\bpay\b|charge|billed|\bcost\b|price|per minute|\$\d/i);
  });

  it('the confirm step carries no CASE chrome — an intro call is pre-engagement (C4)', async () => {
    const user = userEvent.setup();
    const { baseElement } = renderDialog();
    await advanceToConfirm(user);
    expect(baseElement.textContent ?? '').not.toMatch(/\bcase\b/i);
  });
});
