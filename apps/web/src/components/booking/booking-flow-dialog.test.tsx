import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import type { BookConsultationResult } from '@/lib/booking/actions/types';
import type { BookingFlowExpert, BookingContext } from './types';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));
const { mockRouterPush } = vi.hoisted(() => ({ mockRouterPush: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockRouterPush }) }));

const { mockIsMobile } = vi.hoisted(() => ({ mockIsMobile: vi.fn(() => false) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mockIsMobile() }));

// Step 1's calendar is embedded "as shipped" (D3) — mocked here so this file can drive slot
// selection deterministically without exercising the calendar's own (separately tested) fetch
// state machine.
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
          Pick 9:00am slot
        </button>
        {/* A second, GENUINELY DIFFERENT window — wired directly (not through
            `mockOnSlotSelect`, which every existing test's assertions target) so the
            round-2 nonce un-freeze tests can pick a real "different slot". */}
        <button
          type="button"
          onClick={() =>
            props.onSlotSelect?.({
              start: '2026-06-05T10:00:00.000Z',
              end: '2026-06-05T10:30:00.000Z',
              duration: 30,
            })
          }
        >
          Pick 10:00am slot
        </button>
        {props.emptyAction}
      </div>
    );
  },
}));

// The real RichTextEditor is a code-split TipTap (ProseMirror) component that can't mount in
// jsdom (established `project-request-panel.test.tsx` precedent) — mock with a controlled
// textarea emitting the same HTML contract.
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextEditor: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (html: string) => void;
    placeholder?: string;
  }) => {
    const plain = value.replace(/<[^<>]*>/g, '');
    return (
      <textarea
        aria-label="What you'd like to discuss"
        placeholder={placeholder}
        value={plain}
        onChange={(e) => onChange(e.target.value ? `<p>${e.target.value}</p>` : '')}
      />
    );
  },
}));

const mockBookConsultationAction = vi.fn<(input: unknown) => Promise<BookConsultationResult>>();
vi.mock('@/lib/booking/actions/book-consultation', () => ({
  bookConsultationAction: (input: unknown) => mockBookConsultationAction(input),
}));
vi.mock('@/lib/booking/actions/refetch-open-cases', () => ({
  refetchOpenCasesAction: vi.fn().mockResolvedValue({ ok: false }),
}));
vi.mock('@/lib/booking/actions/refetch-booking-context', () => ({
  refetchBookingContextAction: vi.fn().mockResolvedValue({ ok: false }),
}));

import { BookingFlowDialog } from './booking-flow-dialog';

const EXPERT: BookingFlowExpert = {
  expertProfileId: 'expert-1',
  name: 'Amara Okafor',
  firstName: 'Amara',
  initials: 'AO',
  avatarUrl: null,
  partyLabel: 'CloudPeak',
  verified: true,
  availableForWork: true,
};

const SINGLE_COMPANY_NO_CASES: BookingContext = {
  arm: 'single_company',
  company: { id: 'company-1', name: 'Northwind Industrial', logoUrl: null },
  openCases: [],
  resolvedCaseCount: 0,
};

beforeEach(() => {
  mockIsMobile.mockReturnValue(false);
  mockBookConsultationAction.mockReset();
  mockRouterPush.mockClear();
  vi.mocked(track).mockClear();
  vi.mocked(toast.success).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function successResult(overrides: Partial<Extract<BookConsultationResult, { ok: true }>> = {}) {
  return {
    ok: true as const,
    engagementId: 'engagement-1',
    meetingId: 'meeting-1',
    joinPath: '/join/m/meeting-1',
    provisioned: true,
    isNewCase: true,
    caseTitle: 'Discuss migration plan',
    // S2 — the SERVER's window, which the booked state and the toast must render.
    scheduledStartIso: '2026-09-01T04:00:00.000Z',
    scheduledEndIso: '2026-09-01T04:30:00.000Z',
    durationMinutes: 30,
    guestsInvited: 0,
    guestInviteFailed: false,
    ...overrides,
  };
}

describe('BookingFlowDialog — wrapper shell', () => {
  it('renders a Dialog on desktop', () => {
    mockIsMobile.mockReturnValue(false);
    render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: SINGLE_COMPANY_NO_CASES }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders a Sheet (not a Dialog) on mobile', () => {
    mockIsMobile.mockReturnValue(true);
    render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: SINGLE_COMPANY_NO_CASES }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    expect(screen.getByText('Book a consultation with Amara Okafor')).toBeInTheDocument();
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <BookingFlowDialog
        open={false}
        onClose={vi.fn()}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: SINGLE_COMPANY_NO_CASES }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('opens directly into the onboarding-routing state for 0 eligible companies', () => {
    render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: { arm: 'onboarding_required' } }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    expect(screen.getByText("Let's finish setting up your company")).toBeInTheDocument();
    expect(screen.queryByText('Pick 9:00am slot')).not.toBeInTheDocument();
  });

  it('routes to onboarding and closes on "Set up my company"', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <BookingFlowDialog
        open
        onClose={onClose}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: { arm: 'onboarding_required' } }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Set up my company' }));
    expect(mockRouterPush).toHaveBeenCalledWith('/onboarding');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes without navigating on "Not now" from the onboarding-routing state', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <BookingFlowDialog
        open
        onClose={onClose}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: { arm: 'onboarding_required' } }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onClose).toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it('fires FLOW_OPENED with the given source', () => {
    render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="search"
        entry={{ mode: 'chooser', context: SINGLE_COMPANY_NO_CASES }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    expect(track).toHaveBeenCalledWith(
      'booking_flow_opened',
      expect.objectContaining({ expert_id: 'expert-1', source: 'search' })
    );
  });
});

describe('BookingFlowDialog — entry point 3 (fixed case)', () => {
  it('opens directly at confirm, slot pre-filled, with NO case-choice section anywhere', () => {
    render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="case_quick_pick"
        entry={{
          mode: 'fixed_case',
          fixedCase: {
            engagementId: 'engagement-9',
            title: 'Flow interview loop',
            consultationCount: 2,
            openedAtIso: '2026-06-01T00:00:00.000Z',
          },
          presetSlot: {
            startIso: '2026-06-05T09:00:00.000Z',
            endIso: '2026-06-05T09:30:00.000Z',
            durationMinutes: 30,
          },
        }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );

    // Confirm step, not pick-time.
    expect(screen.queryByText('Pick 9:00am slot')).not.toBeInTheDocument();
    // The read-only case-context card, not a chooser.
    expect(screen.getByText('Flow interview loop')).toBeInTheDocument();
    expect(screen.queryByText('Which case is this for?')).not.toBeInTheDocument();
    expect(screen.queryByText('Start a new case')).not.toBeInTheDocument();
    // D4a #3 — no "Not the right case?" escape either (the client explicitly chose this case).
    expect(screen.queryByText(/Not the right case/)).not.toBeInTheDocument();
    // No title/description/products fields (attach-shape only).
    expect(screen.queryByLabelText(/^Title/)).not.toBeInTheDocument();
  });
});

describe('BookingFlowDialog — new-case submit flow', () => {
  it('walks pick-time → confirm → booked on a successful submit', async () => {
    const user = userEvent.setup();
    mockBookConsultationAction.mockResolvedValue(successResult());

    render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: SINGLE_COMPANY_NO_CASES }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );

    await user.click(screen.getByText('Pick 9:00am slot'));
    // Confirm step — case-choice absent (no open cases), billing line always present.
    expect(screen.queryByText('Which case is this for?')).not.toBeInTheDocument();
    expect(screen.getByText(/Charged only for time used/)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/^Title/), 'Migration planning');
    await user.type(
      screen.getByLabelText("What you'd like to discuss"),
      'A real problem statement.'
    );
    await user.click(screen.getByRole('button', { name: /Confirm & book/i }));

    expect(await screen.findByText("You're booked!")).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(
      'case_booked',
      expect.objectContaining({ is_new_case: true })
    );
  });

  it('blocks submit until a title is entered', async () => {
    const user = userEvent.setup();
    render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: SINGLE_COMPANY_NO_CASES }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    await user.click(screen.getByText('Pick 9:00am slot'));
    await user.click(screen.getByRole('button', { name: /Confirm & book/i }));
    expect(mockBookConsultationAction).not.toHaveBeenCalled();
    expect(screen.getByText('Give this a short title.')).toBeInTheDocument();
  });
});

describe('BookingFlowDialog — failure panels + idempotent retry', () => {
  it('shows the partial-failure panel on a stage:"meeting" failure, and "Try again" reuses the SAME nonce', async () => {
    const user = userEvent.setup();
    mockBookConsultationAction.mockResolvedValueOnce({
      ok: false,
      stage: 'meeting',
      code: 'booking_failed',
      engagementId: 'engagement-5',
      caseTitle: 'Migration planning',
    });
    mockBookConsultationAction.mockResolvedValueOnce(successResult({ isNewCase: false }));

    render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: SINGLE_COMPANY_NO_CASES }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    await user.click(screen.getByText('Pick 9:00am slot'));
    await user.type(screen.getByLabelText(/^Title/), 'Migration planning');
    await user.type(
      screen.getByLabelText("What you'd like to discuss"),
      'A real problem statement.'
    );
    await user.click(screen.getByRole('button', { name: /Confirm & book/i }));

    expect(
      await screen.findByText("Your case is saved — we just couldn't lock in the time")
    ).toBeInTheDocument();

    const firstCallInput = mockBookConsultationAction.mock.calls[0]?.[0] as {
      bookingNonce: string;
    };
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText("You're booked!")).toBeInTheDocument();
    const secondCallInput = mockBookConsultationAction.mock.calls[1]?.[0] as {
      bookingNonce: string;
      caseChoice: unknown;
    };
    expect(secondCallInput.bookingNonce).toBe(firstCallInput.bookingNonce);
    expect(secondCallInput.caseChoice).toEqual({
      kind: 'existing',
      engagementId: 'engagement-5',
    });
  });

  it('shows the hard-failure panel on any other failure', async () => {
    const user = userEvent.setup();
    mockBookConsultationAction.mockResolvedValue({
      ok: false,
      stage: 'validation',
      code: 'invalid_request',
    });
    render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: SINGLE_COMPANY_NO_CASES }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    await user.click(screen.getByText('Pick 9:00am slot'));
    await user.type(screen.getByLabelText(/^Title/), 'Migration planning');
    await user.type(
      screen.getByLabelText("What you'd like to discuss"),
      'A real problem statement.'
    );
    await user.click(screen.getByRole('button', { name: /Confirm & book/i }));
    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
  });

  it('shows the inline stale-slot banner (not a full panel) and preserves the typed title', async () => {
    const user = userEvent.setup();
    mockBookConsultationAction.mockResolvedValue({
      ok: false,
      stage: 'meeting',
      code: 'slot_unavailable',
      engagementId: 'engagement-6',
      caseTitle: 'Migration planning',
    });
    render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: SINGLE_COMPANY_NO_CASES }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    await user.click(screen.getByText('Pick 9:00am slot'));
    await user.type(screen.getByLabelText(/^Title/), 'Migration planning');
    await user.type(
      screen.getByLabelText("What you'd like to discuss"),
      'A real problem statement.'
    );
    await user.click(screen.getByRole('button', { name: /Confirm & book/i }));

    expect(
      await screen.findByText('This time was just booked by someone else.')
    ).toBeInTheDocument();
    // Still on the confirm step (inline, not a full-panel replacement) — the title survives.
    expect(screen.getByLabelText(/^Title/)).toHaveValue('Migration planning');
  });

  // M2 [CRITICAL] — the ordinary path (title filled, description left blank) used to submit
  // straight to the server and dead-end on the generic hard panel. It must never reach the
  // action at all.
  it('blocks submit until the description has REAL text content — a bare title is not enough', async () => {
    const user = userEvent.setup();
    render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: SINGLE_COMPANY_NO_CASES }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    await user.click(screen.getByText('Pick 9:00am slot'));
    await user.type(screen.getByLabelText(/^Title/), 'Migration planning');
    await user.click(screen.getByRole('button', { name: /Confirm & book/i }));
    expect(mockBookConsultationAction).not.toHaveBeenCalled();
    expect(
      screen.getByText("Add a few words about what you'd like to discuss.")
    ).toBeInTheDocument();
  });
});

// ⚠⚠ THE NONCE UN-FREEZE/RE-MINT REGRESSION TEST (round 2 — the contract round 1 changed).
// Round 1 made a same-key resubmit against a DIFFERENT window 409 `idempotency_key_conflict`
// instead of silently replaying. `caseAlreadyCreatedRef` freezing the nonce forever after ANY
// `stage:'meeting'` failure meant a client who then picked a genuinely different slot kept
// resubmitting the SAME key — conflicting forever, with no way to ever book the new time.
describe('BookingFlowDialog — the nonce freeze/un-freeze after a meeting-hop failure', () => {
  async function bookToPartialFailure(user: ReturnType<typeof userEvent.setup>) {
    render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: SINGLE_COMPANY_NO_CASES }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    await user.click(screen.getByText('Pick 9:00am slot'));
    await user.type(screen.getByLabelText(/^Title/), 'Migration planning');
    await user.type(
      screen.getByLabelText("What you'd like to discuss"),
      'A real problem statement.'
    );
    await user.click(screen.getByRole('button', { name: /Confirm & book/i }));
    await screen.findByText("Your case is saved — we just couldn't lock in the time");
  }

  it('SAME slot re-pick after a partial failure keeps the SAME nonce (a true meeting-hop replay)', async () => {
    const user = userEvent.setup();
    mockBookConsultationAction.mockResolvedValueOnce({
      ok: false,
      stage: 'meeting',
      code: 'booking_failed',
      engagementId: 'engagement-5',
      caseTitle: 'Migration planning',
    });
    mockBookConsultationAction.mockResolvedValueOnce(successResult({ isNewCase: false }));

    await bookToPartialFailure(user);
    const firstNonce = (mockBookConsultationAction.mock.calls[0]?.[0] as { bookingNonce: string })
      .bookingNonce;

    await user.click(screen.getByRole('button', { name: 'Choose a different time' }));
    // The mocked calendar always offers the SAME 9:00am/9:30am slot — re-picking it is the
    // same-slot half of this test.
    await user.click(screen.getByText('Pick 9:00am slot'));
    await user.click(screen.getByRole('button', { name: /Confirm & book/i }));
    await screen.findByText("You're booked!");

    const secondNonce = (mockBookConsultationAction.mock.calls[1]?.[0] as { bookingNonce: string })
      .bookingNonce;
    expect(secondNonce).toBe(firstNonce);
  });

  it('a DIFFERENT slot after a partial failure mints a NEW nonce, avoiding a permanent idempotency_key_conflict', async () => {
    const user = userEvent.setup();
    mockBookConsultationAction.mockResolvedValueOnce({
      ok: false,
      stage: 'meeting',
      code: 'booking_failed',
      engagementId: 'engagement-5',
      caseTitle: 'Migration planning',
    });
    mockBookConsultationAction.mockResolvedValueOnce(successResult({ isNewCase: false }));

    await bookToPartialFailure(user);
    const firstNonce = (mockBookConsultationAction.mock.calls[0]?.[0] as { bookingNonce: string })
      .bookingNonce;

    await user.click(screen.getByRole('button', { name: 'Choose a different time' }));
    // A genuinely DIFFERENT slot than the one that failed (10:00am, not 9:00am).
    await user.click(screen.getByText('Pick 10:00am slot'));
    await user.click(screen.getByRole('button', { name: /Confirm & book/i }));
    await screen.findByText("You're booked!");

    const secondCall = mockBookConsultationAction.mock.calls[1]?.[0] as {
      bookingNonce: string;
      slot: { startIso: string };
    };
    expect(secondCall.bookingNonce).not.toBe(firstNonce);
    expect(secondCall.slot.startIso).toBe('2026-06-05T10:00:00.000Z');
  });
});
