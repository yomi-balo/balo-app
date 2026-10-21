import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, within } from '@/test/utils';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import type { BookConsultationResult } from '@/lib/booking/actions/types';
import { SESSION_EXPIRED_MESSAGE } from '@/lib/auth/auth-error-copy';
import { refetchOpenCasesAction } from '@/lib/booking/actions/refetch-open-cases';
import { refetchBookingContextAction } from '@/lib/booking/actions/refetch-booking-context';
import { TOP_UP_LIMITS_MINOR } from '@balo/shared/credit';
import { companyWorkspaceKey } from '@balo/shared/workspaces';
import { readBookingDraft, writeBookingDraft, type BookingDraft } from './booking-draft';
import { refusedView } from './funding/funding-fixtures';
import type { BookingFlowExpert, BookingContext } from './types';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
const { mockRouterPush } = vi.hoisted(() => ({ mockRouterPush: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockRouterPush }) }));

const { mockSwitchWorkspaceAction } = vi.hoisted(() => ({ mockSwitchWorkspaceAction: vi.fn() }));
vi.mock('@/lib/auth/actions/switch-workspace', () => ({
  switchWorkspaceAction: (...args: unknown[]) => mockSwitchWorkspaceAction(...args),
}));

const { mockCaptureException, mockCaptureMessage } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
  mockCaptureMessage: vi.fn(),
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: (...args: unknown[]) => mockCaptureMessage(...args),
}));

const { mockAuthModalOpen } = vi.hoisted(() => ({ mockAuthModalOpen: vi.fn() }));
vi.mock('@/hooks/use-auth-modal', () => ({
  useAuthModal: () => ({ open: mockAuthModalOpen, close: vi.fn(), isOpen: false }),
}));

const { mockIsMobile } = vi.hoisted(() => ({ mockIsMobile: vi.fn(() => false) }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mockIsMobile() }));

// Step 1's calendar is embedded "as shipped" (D3) — mocked here so this file can drive slot
// selection deterministically without exercising the calendar's own (separately tested) fetch
// state machine.
const { mockOnSlotSelect, mockCalendarScope } = vi.hoisted(() => ({
  mockOnSlotSelect: vi.fn(),
  mockCalendarScope: { value: undefined as string | undefined },
}));
vi.mock('@/components/availability', () => ({
  ExpertAvailabilityCalendar: (props: {
    onSlotSelect?: (s: { start: string; end: string; duration: 15 | 30 | 45 | 60 }) => void;
    emptyAction?: React.ReactNode;
    scope?: string;
  }) => {
    mockCalendarScope.value = props.scope;
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

const { mockReadBookingFundingAction, mockSaveBookingForLaterAction, mockBlockBeforePay } =
  vi.hoisted(() => ({
    mockReadBookingFundingAction: vi.fn(),
    mockSaveBookingForLaterAction: vi.fn(),
    mockBlockBeforePay: vi.fn(),
  }));
vi.mock('@/lib/booking/actions/read-booking-funding', () => ({
  readBookingFundingAction: (input: unknown) => mockReadBookingFundingAction(input),
}));
vi.mock('@/lib/booking/actions/save-booking-for-later', () => ({
  saveBookingForLaterAction: (input: unknown) => mockSaveBookingForLaterAction(input),
}));

// The block's internals are covered by its own test; here a stub exposes its callbacks so the
// dialog's wiring (draft, nonce, refresh, Save) is what is under test.
vi.mock('./funding/booking-funding-block', () => ({
  BookingFundingBlock: (props: {
    view: { arm: string; canManageBilling: boolean };
    caseSaved: { caseTitle: string } | null;
    ctaDisabled: boolean;
    onBeforePay: () => boolean;
    onFunded: (
      funded:
        | { method: 'topup'; creditedMinor: number; companyName: string | null }
        | { method: 'pay_after'; card: null; companyName: string | null }
    ) => Promise<boolean>;
    onSaveForLater: () => Promise<void>;
    draftKept: boolean;
    onBusyChange: (busy: boolean) => void;
    onInFlightChange: (inFlight: boolean) => void;
  }) => (
    <div data-testid="funding-block" data-arm={props.view.arm}>
      <span>
        {props.caseSaved === null ? 'no case saved' : `case saved: ${props.caseSaved.caseTitle}`}
      </span>
      <span>{props.ctaDisabled ? 'cta disabled' : 'cta enabled'}</span>
      <span>{props.draftKept ? 'draft kept' : 'no draft'}</span>
      <button type="button" onClick={() => props.onBusyChange(true)}>
        Stub busy
      </button>
      <button
        type="button"
        onClick={() => {
          props.onBusyChange(true);
          props.onInFlightChange(true);
        }}
      >
        Stub in flight
      </button>
      <button type="button" onClick={() => mockBlockBeforePay(props.onBeforePay())}>
        Stub before pay
      </button>
      <button
        type="button"
        onClick={() => {
          props
            .onFunded({
              method: 'topup',
              creditedMinor: 30_000,
              companyName: 'Northwind Industrial',
            })
            .catch(() => {});
        }}
      >
        Stub funded
      </button>
      <button
        type="button"
        onClick={() => {
          props
            .onFunded({ method: 'pay_after', card: null, companyName: 'Northwind Industrial' })
            .catch(() => {});
        }}
      >
        Stub funded pay after
      </button>
      <button
        type="button"
        onClick={() => {
          props.onSaveForLater().catch(() => {});
        }}
      >
        Stub save
      </button>
    </div>
  ),
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
  viewerUserId: 'user-1',
  company: { id: 'company-1', name: 'Northwind Industrial', logoUrl: null },
  openCases: [],
  resolvedCaseCount: 0,
};

beforeEach(() => {
  mockIsMobile.mockReturnValue(false);
  mockBookConsultationAction.mockReset();
  mockRouterPush.mockClear();
  mockSwitchWorkspaceAction.mockReset();
  mockCaptureException.mockClear();
  mockCaptureMessage.mockClear();
  vi.mocked(track).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
  mockReadBookingFundingAction.mockReset();
  mockReadBookingFundingAction.mockResolvedValue({ kind: 'clear' });
  mockSaveBookingForLaterAction.mockReset();
  mockBlockBeforePay.mockReset();
  globalThis.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function successResult(overrides: Partial<Extract<BookConsultationResult, { ok: true }>> = {}) {
  return {
    ok: true as const,
    engagementId: 'engagement-1',
    meetingId: 'meeting-1',
    joinPath: '/meetings/meeting-1/call',
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

describe('BookingFlowDialog — slot scope and unavailable header (BAL-591)', () => {
  function renderFlow(
    props: Partial<React.ComponentProps<typeof BookingFlowDialog>> = {}
  ): ReturnType<typeof render> {
    return render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: SINGLE_COMPANY_NO_CASES }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
        {...props}
      />
    );
  }

  it('leaves the scope unset (new_work) for the profile consultation flow', () => {
    renderFlow();
    expect(mockCalendarScope.value).toBeUndefined();
  });

  it('forwards an explicit scope to the slot grid', () => {
    renderFlow({ scope: 'existing_work' });
    expect(mockCalendarScope.value).toBe('existing_work');
  });

  it('labels a stale link to a paused expert "Not taking on new work", not "Booking anyway"', () => {
    renderFlow({ expert: { ...EXPERT, availableForWork: false } });
    expect(screen.getByText('Not taking on new work')).toBeInTheDocument();
    expect(screen.queryByText('Booking anyway')).not.toBeInTheDocument();
  });
});

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

  // Wide enough for Step 1's embedded ExpertAvailabilityCalendar's two-pane layout, same width
  // and reasoning as reschedule-dialog.tsx, capped so it never overflows a small viewport.
  it('is wide enough to host the two-pane calendar, capped against the viewport', () => {
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
    expect(document.querySelector('[data-slot="dialog-content"]')).toHaveClass(
      'sm:max-w-[min(92vw,840px)]'
    );
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
    // No title/description/products fields (attach-shape only).
    expect(screen.queryByLabelText(/^Title/)).not.toBeInTheDocument();
  });

  it('opens on the calendar without a preset slot, and Back returns to it rather than closing', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <BookingFlowDialog
        open
        onClose={onClose}
        expert={EXPERT}
        source="book_again"
        entry={{
          mode: 'fixed_case',
          fixedCase: {
            engagementId: 'engagement-9',
            title: 'Flow interview loop',
            consultationCount: 2,
            openedAtIso: '2026-06-01T00:00:00.000Z',
          },
          presetSlot: null,
        }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );

    await user.click(screen.getByText('Pick 9:00am slot'));
    // The case stays fixed once a time is picked: its context card, never a chooser.
    expect(screen.getByText('Flow interview loop')).toBeInTheDocument();
    expect(screen.queryByText('Which case is this for?')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Title/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Pick 9:00am slot')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('BookingFlowDialog — entry point 3 switching case from the dropdown', () => {
  // Radix Select needs the Pointer Capture APIs jsdom lacks (`company-picker.test.tsx`).
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn();
    Element.prototype.setPointerCapture = vi.fn();
    Element.prototype.releasePointerCapture = vi.fn();
  });

  const THIS_CASE = {
    engagementId: 'engagement-9',
    title: 'Flow interview loop',
    createdAt: '2026-06-01T00:00:00.000Z',
    lastActivityAt: '2026-06-02T00:00:00.000Z',
    consultationCount: 2,
  };
  const OTHER_CASE = {
    engagementId: 'engagement-4',
    title: 'Duplicate cleanup',
    createdAt: '2026-05-01T00:00:00.000Z',
    lastActivityAt: '2026-05-02T00:00:00.000Z',
    consultationCount: 1,
  };

  function renderFromCase(): void {
    render(
      <BookingFlowDialog
        open
        onClose={vi.fn()}
        expert={EXPERT}
        source="book_again"
        entry={{
          mode: 'fixed_case',
          fixedCase: {
            engagementId: 'engagement-9',
            title: 'Flow interview loop',
            consultationCount: 2,
            openedAtIso: '2026-06-01T00:00:00.000Z',
          },
          presetSlot: null,
        }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
  }

  it('preselects this case, and can switch to another case or start a new one', async () => {
    const user = userEvent.setup();
    vi.mocked(refetchBookingContextAction).mockResolvedValueOnce({
      ok: true,
      context: {
        ...(SINGLE_COMPANY_NO_CASES as Extract<BookingContext, { arm: 'single_company' }>),
        openCases: [OTHER_CASE, THIS_CASE],
      },
    });
    renderFromCase();
    await user.click(screen.getByText('Pick 9:00am slot'));

    const dropdown = await screen.findByRole('combobox', { name: 'Which case is this for?' });
    expect(dropdown).toHaveTextContent('Flow interview loop');
    expect(screen.queryByLabelText(/^Title/)).not.toBeInTheDocument();

    await user.click(dropdown);
    await user.click(await screen.findByRole('option', { name: /Duplicate cleanup/ }));
    expect(dropdown).toHaveTextContent('Duplicate cleanup');

    await user.click(dropdown);
    await user.click(await screen.findByRole('option', { name: /Start a new case/ }));
    expect(screen.getByLabelText(/^Title/)).toBeInTheDocument();
  });

  it('keeps the case fixed, card and all, when the open cases cannot be listed', async () => {
    const user = userEvent.setup();
    vi.mocked(refetchBookingContextAction).mockResolvedValueOnce({ ok: false });
    renderFromCase();
    await user.click(screen.getByText('Pick 9:00am slot'));

    expect(screen.getByText('Flow interview loop')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Which case is this for?' })).toBeNull();
  });

  it('keeps the case fixed when the listed open cases do not include it', async () => {
    const user = userEvent.setup();
    vi.mocked(refetchBookingContextAction).mockResolvedValueOnce({
      ok: true,
      context: {
        ...(SINGLE_COMPANY_NO_CASES as Extract<BookingContext, { arm: 'single_company' }>),
        openCases: [OTHER_CASE],
      },
    });
    renderFromCase();
    await user.click(screen.getByText('Pick 9:00am slot'));
    await vi.waitFor(() => expect(refetchBookingContextAction).toHaveBeenCalled());

    expect(screen.getByText('Flow interview loop')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Which case is this for?' })).toBeNull();
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

  describe('session_expired — sign-in, never a message about the slot', () => {
    async function submitWith(
      user: ReturnType<typeof userEvent.setup>,
      result: Extract<BookConsultationResult, { ok: false }>
    ): Promise<void> {
      mockBookConsultationAction.mockResolvedValue(result);
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
    }

    it('pre-flight refusal offers sign-in and says nothing was saved', async () => {
      const user = userEvent.setup();
      await submitWith(user, { ok: false, stage: 'validation', code: 'session_expired' });

      expect(await screen.findByText('Sign in to finish booking')).toBeInTheDocument();
      expect(screen.getByText(/nothing was saved/i)).toBeInTheDocument();
      // ⚠ Never the partial panel: its headline is about the SLOT, and its only action
      // re-sends the same dead token.
      expect(screen.queryByText(/couldn't lock in the time/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Try again/i })).not.toBeInTheDocument();
    });

    it('mid-submit refusal names the case that WAS written', async () => {
      const user = userEvent.setup();
      await submitWith(user, {
        ok: false,
        stage: 'meeting',
        code: 'session_expired',
        engagementId: 'engagement-9',
        caseTitle: 'Migration planning',
      });

      expect(await screen.findByText('Sign in to finish booking')).toBeInTheDocument();
      expect(screen.getByText(/“Migration planning” is saved/)).toBeInTheDocument();
      expect(screen.queryByText(/nothing was saved/i)).not.toBeInTheDocument();
    });

    /**
     * ⚠ The dialog must still be mounted afterwards. Re-authenticating is what lets the draft,
     * the slot and the nonce survive — a navigation would discard all three, and the panel's
     * own copy promises it does not.
     */
    it('"Sign in" re-authenticates in place and returns to confirm on success', async () => {
      const user = userEvent.setup();
      await submitWith(user, { ok: false, stage: 'validation', code: 'session_expired' });
      await user.click(await screen.findByRole('button', { name: 'Sign in' }));

      expect(mockRouterPush).not.toHaveBeenCalled();
      expect(mockAuthModalOpen).toHaveBeenCalledTimes(1);
      const options = mockAuthModalOpen.mock.calls[0]?.[0] as {
        initialError?: string;
        onSuccess?: () => void;
      };
      expect(options.initialError).toBe(SESSION_EXPIRED_MESSAGE);

      options.onSuccess?.();
      expect(await screen.findByRole('button', { name: /Confirm & book/i })).toBeInTheDocument();
      expect(screen.queryByText('Sign in to finish booking')).not.toBeInTheDocument();
    });

    /**
     * An impersonated session holds no access token at all, so it fails the credential
     * pre-flight for a reason that has nothing to do with expiry. Offering it "Sign in" would
     * sign the staff member in as themselves and end the impersonation.
     */
    it.each([
      ['stage:case (paused, before any write)', { stage: 'case' as const }],
      [
        'stage:meeting (owner not live, case already written)',
        { stage: 'meeting' as const, engagementId: 'eng-1', caseTitle: 'Migration planning' },
      ],
    ])(
      'expert_unavailable at %s renders its own panel: no retry, no partial-failure copy',
      async (_label, extra) => {
        const user = userEvent.setup();
        await submitWith(user, { ok: false, code: 'expert_unavailable', ...extra });

        expect(
          await screen.findByText("Amara isn't taking on new work right now.")
        ).toBeInTheDocument();
        expect(
          screen.getByText('We can introduce you to someone with similar experience.')
        ).toBeInTheDocument();
        const panel = screen
          .getByText("Amara isn't taking on new work right now.")
          .closest('div')?.parentElement;
        expect(panel).not.toBeNull();
        expect(
          within(panel as HTMLElement).getByRole('button', { name: 'Close' })
        ).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Try again/i })).not.toBeInTheDocument();
        expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
      }
    );

    it('an impersonation refusal names its own reason, with no sign-in and no retry', async () => {
      const user = userEvent.setup();
      await submitWith(user, {
        ok: false,
        stage: 'validation',
        code: 'impersonation_refused',
      });

      expect(await screen.findByText(/can't be made while impersonating/i)).toBeInTheDocument();
      expect(screen.queryByText('Sign in to finish booking')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Try again/i })).not.toBeInTheDocument();
    });
  });

  describe('funding pre-condition (BAL-478)', () => {
    // An unreadable pre-flight is the fallback to today's full panel, which is what these prove.
    beforeEach(() => {
      mockReadBookingFundingAction.mockResolvedValue({ kind: 'unavailable' });
    });

    async function submitWithFundingResult(
      user: ReturnType<typeof userEvent.setup>,
      result: Extract<BookConsultationResult, { ok: false }>
    ): Promise<void> {
      mockBookConsultationAction.mockResolvedValue(result);
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
    }

    it('funding_setup_required renders the panel, and "Set up billing" routes to /settings/billing', async () => {
      const user = userEvent.setup();
      await submitWithFundingResult(user, {
        ok: false,
        stage: 'funding',
        code: 'funding_setup_required',
      });

      expect(await screen.findByText('One setup step first')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Set up billing' }));
      expect(mockRouterPush).toHaveBeenCalledWith('/settings/billing');
    });

    it('funding_admins_notified renders the panel, mentions billing admins, and offers NO dead-end CTA', async () => {
      const user = userEvent.setup();
      await submitWithFundingResult(user, {
        ok: false,
        stage: 'funding',
        code: 'funding_admins_notified',
      });

      expect(await screen.findByText('One setup step first')).toBeInTheDocument();
      expect(screen.getByText(/billing admins have been notified/i)).toBeInTheDocument();
      // ⚠ Per-assertion mutation proof: the holder-arm control IS present in the OTHER case
      // (above), so this negative is not vacuous.
      expect(screen.queryByRole('button', { name: /set up billing/i })).toBeNull();
      expect(mockRouterPush).not.toHaveBeenCalled();
    });

    // REV-6 (fix round) — the original version of this test exercised `funding_setup_required`
    // only; `funding_admins_notified` renders DIFFERENT copy (the "billing admins have been
    // told" body) and needs its own no-money-figure proof.
    it.each([['funding_setup_required' as const], ['funding_admins_notified' as const]])(
      'the %s arm renders no money figure',
      async (code) => {
        const user = userEvent.setup();
        const { container } = render(
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
        mockBookConsultationAction.mockResolvedValue({ ok: false, stage: 'funding', code });
        await user.click(screen.getByText('Pick 9:00am slot'));
        await user.type(screen.getByLabelText(/^Title/), 'Migration planning');
        await user.type(
          screen.getByLabelText("What you'd like to discuss"),
          'A real problem statement.'
        );
        await user.click(screen.getByRole('button', { name: /Confirm & book/i }));
        expect(await screen.findByText('One setup step first')).toBeInTheDocument();

        expect(container.textContent).not.toContain('$');
        expect(container.textContent).not.toContain('A$');
      }
    );
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

describe('BookingFlowDialog — the balance refusals (BAL-474: D6.1 hold, D6.5 reservation)', () => {
  const HELD_COMPANY = { id: 'company-1', name: 'Northwind Industrial', isActive: true };

  // An unreadable pre-flight is the fallback to today's full panel, which is what these prove.
  beforeEach(() => {
    mockReadBookingFundingAction.mockResolvedValue({ kind: 'unavailable' });
  });

  type FailureResult = Extract<BookConsultationResult, { ok: false }>;

  function holdFailure(overrides: Partial<FailureResult> = {}): FailureResult {
    return {
      ok: false,
      stage: 'funding',
      code: 'hold_top_up_required',
      balance: {
        variant: 'hold',
        topUpNeededMinor: 27_500,
        reservedBookingCount: null,
        company: HELD_COMPANY,
      },
      ...overrides,
    };
  }

  function reservedFailure(overrides: Partial<FailureResult> = {}): FailureResult {
    return {
      ok: false,
      stage: 'funding',
      code: 'reserved_top_up_required',
      balance: {
        variant: 'reserved',
        topUpNeededMinor: 7_500,
        reservedBookingCount: 2,
        company: HELD_COMPANY,
      },
      ...overrides,
    };
  }

  /** BAL-474 (D11.3 N3) — the last dialog `submitWith` rendered: its `onClose` and a way to flip `open`. */
  let lastDialog: { onClose: ReturnType<typeof vi.fn>; setOpen: (open: boolean) => void } | null =
    null;

  async function submitWith(result: FailureResult): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup();
    mockBookConsultationAction.mockResolvedValue(result);
    const onClose = vi.fn();
    const dialog = (open: boolean): React.JSX.Element => (
      <BookingFlowDialog
        open={open}
        onClose={onClose}
        expert={EXPERT}
        source="profile"
        entry={{ mode: 'chooser', context: SINGLE_COMPANY_NO_CASES }}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
    const view = render(dialog(true));
    lastDialog = { onClose, setOpen: (open) => view.rerender(dialog(open)) };
    await user.click(screen.getByText('Pick 9:00am slot'));
    await user.type(screen.getByLabelText(/^Title/), 'Migration planning');
    await user.type(
      screen.getByLabelText("What you'd like to discuss"),
      'A real problem statement.'
    );
    await user.click(screen.getByRole('button', { name: /Confirm & book/i }));
    return user;
  }

  it('a hold refusal renders the balance panel with the top-up figure — and NOT the BAL-478 setup panel', async () => {
    await submitWith(holdFailure());

    expect(await screen.findByText('One thing to settle first')).toBeInTheDocument();
    expect(
      screen.getByText(
        "Northwind Industrial's balance needs a top-up of A$275.00 or more before new consultations can be booked. Consultations already booked aren't affected."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('One setup step first')).not.toBeInTheDocument();
  });

  it('a reservation refusal renders the reserved variant with the COUNT', async () => {
    await submitWith(reservedFailure());

    expect(
      await screen.findByText(
        "Part of Northwind Industrial's balance is set aside for planned consultations"
      )
    ).toBeInTheDocument();
    expect(screen.getByText(/set aside for 2 upcoming consultations/)).toBeInTheDocument();
  });

  it('the failed-heal fallback (no figure) renders the fallback panel — never A$0.00', async () => {
    await submitWith(
      holdFailure({
        balance: {
          variant: 'hold',
          topUpNeededMinor: null,
          reservedBookingCount: null,
          company: HELD_COMPANY,
        },
      })
    );

    expect(await screen.findByText('An earlier hold is still clearing')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('A$');
  });

  it.each([
    ['at the maximum', 1_000_000, 'needs a top-up of A$10,000.00 or more'],
    ['one minor above the maximum', 1_000_001, 'needs top-ups totalling A$10,000.01 or more'],
  ])(
    'the "top-ups totalling" wording flips %s (TOP_UP_LIMITS_MINOR.max)',
    async (_label, amount, text) => {
      await submitWith(
        holdFailure({
          balance: {
            variant: 'hold',
            topUpNeededMinor: amount,
            reservedBookingCount: null,
            company: HELD_COMPANY,
          },
        })
      );

      expect(
        await screen.findByText(new RegExp(text.replace(/[.$]/g, '\\$&')))
      ).toBeInTheDocument();
    }
  );

  it('a plain member sees the figure, "Got it", and NO top-up button', async () => {
    const user = await submitWith(holdFailure({ code: 'hold_admins_notified' }));

    expect(await screen.findByText(/Your billing admins have been notified/)).toBeInTheDocument();
    expect(screen.getByText(/A\$275\.00 or more/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /top up/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Got it' }));
  });

  it('a malformed reservation (no figure) falls to the generic hard panel, never a panel with a made-up figure', async () => {
    await submitWith(
      reservedFailure({
        balance: {
          variant: 'reserved',
          topUpNeededMinor: null,
          reservedBookingCount: 2,
          company: HELD_COMPANY,
        },
      })
    );

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('A$');
  });

  it('a balance code with no balance payload falls to the generic hard panel', async () => {
    await submitWith({ ok: false, stage: 'funding', code: 'hold_top_up_required' });

    expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
  });

  it('is an expected refusal: NO Sentry capture and NO client track() for it', async () => {
    await submitWith(holdFailure());
    await screen.findByText('One thing to settle first');

    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
    for (const [event] of vi.mocked(track).mock.calls) {
      expect(String(event)).not.toMatch(/funding|balance|hold|reserved/i);
    }
  });

  describe('Top up — it targets the company that refused', () => {
    it('the held company is the ACTIVE workspace: just navigates, no switch', async () => {
      const user = await submitWith(holdFailure());

      await user.click(await screen.findByRole('button', { name: 'Top up' }));

      expect(mockRouterPush).toHaveBeenCalledWith('/billing/top-up');
      expect(mockSwitchWorkspaceAction).not.toHaveBeenCalled();
    });

    it('NOT the active workspace: switches to THAT company first, then navigates', async () => {
      mockSwitchWorkspaceAction.mockResolvedValue({ success: true });
      const user = await submitWith(
        holdFailure({
          balance: {
            variant: 'hold',
            topUpNeededMinor: 27_500,
            reservedBookingCount: null,
            company: { ...HELD_COMPANY, isActive: false },
          },
        })
      );

      await user.click(
        await screen.findByRole('button', { name: 'Switch to Northwind Industrial and top up' })
      );

      expect(mockSwitchWorkspaceAction).toHaveBeenCalledWith('company:company-1');
      expect(mockRouterPush).toHaveBeenCalledWith('/billing/top-up');
      // Order: the switch resolved BEFORE the navigation.
      expect(mockSwitchWorkspaceAction.mock.invocationCallOrder[0]).toBeLessThan(
        mockRouterPush.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
      );
      expect(toast.error).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });

    describe('D11.3 (N3) — a switch in flight cannot be undone by closing the dialog', () => {
      const NOT_ACTIVE = {
        balance: {
          variant: 'hold' as const,
          topUpNeededMinor: 27_500,
          reservedBookingCount: null,
          company: { ...HELD_COMPANY, isActive: false },
        },
      };

      it('⚠ Escape while the switch is pending is IGNORED — the dialog stays open and onClose never fires', async () => {
        let finishSwitch: (value: { success: boolean }) => void = () => {};
        mockSwitchWorkspaceAction.mockReturnValue(
          new Promise((resolve) => {
            finishSwitch = resolve;
          })
        );
        const user = await submitWith(holdFailure(NOT_ACTIVE));

        await user.click(
          await screen.findByRole('button', { name: 'Switch to Northwind Industrial and top up' })
        );
        await user.keyboard('{Escape}');

        expect(lastDialog?.onClose).not.toHaveBeenCalled();
        expect(screen.getByText('One thing to settle first')).toBeInTheDocument();

        await act(async () => {
          finishSwitch({ success: true });
        });
        expect(mockRouterPush).toHaveBeenCalledWith('/billing/top-up');
      });

      it('once the switch has FAILED the dialog can be dismissed again', async () => {
        mockSwitchWorkspaceAction.mockResolvedValue({ success: false, error: 'nope' });
        const user = await submitWith(holdFailure(NOT_ACTIVE));

        await user.click(
          await screen.findByRole('button', { name: 'Switch to Northwind Industrial and top up' })
        );
        await screen.findByRole('button', { name: 'Switch to Northwind Industrial and top up' });
        await user.keyboard('{Escape}');

        expect(lastDialog?.onClose).toHaveBeenCalledTimes(1);
      });

      it('⚠ a switch that resolves AFTER the dialog was closed does NOT navigate', async () => {
        let finishSwitch: (value: { success: boolean }) => void = () => {};
        mockSwitchWorkspaceAction.mockReturnValue(
          new Promise((resolve) => {
            finishSwitch = resolve;
          })
        );
        const user = await submitWith(holdFailure(NOT_ACTIVE));

        await user.click(
          await screen.findByRole('button', { name: 'Switch to Northwind Industrial and top up' })
        );
        // The parent closes the dialog while the switch is still awaiting (e.g. a route change).
        act(() => lastDialog?.setOpen(false));
        await act(async () => {
          finishSwitch({ success: true });
        });

        expect(mockRouterPush).not.toHaveBeenCalled();
      });
    });

    it('a FAILED switch toasts, does NOT navigate, and the panel stays with an enabled button', async () => {
      mockSwitchWorkspaceAction.mockResolvedValue({ success: false, error: 'nope' });
      const user = await submitWith(
        holdFailure({
          balance: {
            variant: 'hold',
            topUpNeededMinor: 27_500,
            reservedBookingCount: null,
            company: { ...HELD_COMPANY, isActive: false },
          },
        })
      );

      const button = await screen.findByRole('button', {
        name: 'Switch to Northwind Industrial and top up',
      });
      await user.click(button);

      expect(toast.error).toHaveBeenCalledWith(
        "We couldn't switch to Northwind Industrial. Please try again."
      );
      expect(mockRouterPush).not.toHaveBeenCalled();
      expect(screen.getByText('One thing to settle first')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Switch to Northwind Industrial and top up' })
      ).toBeEnabled();
    });

    it('a THROWN switch is captured, toasts the same copy, and stays', async () => {
      mockSwitchWorkspaceAction.mockRejectedValue(new Error('network down'));
      const user = await submitWith(
        holdFailure({
          balance: {
            variant: 'hold',
            topUpNeededMinor: 27_500,
            reservedBookingCount: null,
            company: { ...HELD_COMPANY, isActive: false },
          },
        })
      );

      await user.click(
        await screen.findByRole('button', { name: 'Switch to Northwind Industrial and top up' })
      );

      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(toast.error).toHaveBeenCalledWith(
        "We couldn't switch to Northwind Industrial. Please try again."
      );
      expect(mockRouterPush).not.toHaveBeenCalled();
    });

    it('a null company name uses the unnamed labels on the button and the failure toast', async () => {
      mockSwitchWorkspaceAction.mockResolvedValue({ success: false, error: 'nope' });
      const user = await submitWith(
        holdFailure({
          balance: {
            variant: 'hold',
            topUpNeededMinor: 27_500,
            reservedBookingCount: null,
            company: { id: 'company-1', name: null, isActive: false },
          },
        })
      );

      await user.click(await screen.findByRole('button', { name: 'Switch company and top up' }));

      expect(toast.error).toHaveBeenCalledWith("We couldn't switch companies. Please try again.");
      expect(screen.getByText(/^Your team's balance needs a top-up/)).toBeInTheDocument();
    });

    it('"I\'ll do this later" closes the dialog without navigating', async () => {
      const onClose = vi.fn();
      const user = userEvent.setup();
      mockBookConsultationAction.mockResolvedValue(holdFailure());
      render(
        <BookingFlowDialog
          open
          onClose={onClose}
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

      await user.click(await screen.findByRole('button', { name: "I'll do this later" }));

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(mockRouterPush).not.toHaveBeenCalled();
    });
  });

  describe('hop-2 refusals carry stage:meeting — resolved by CODE, before the partial arm', () => {
    it('a hold refused at the meeting hop shows the balance panel and the case-saved line, NOT "we just couldn\'t lock in the time"', async () => {
      await submitWith(
        holdFailure({
          stage: 'meeting',
          engagementId: 'engagement-7',
          caseTitle: 'Migration planning',
        })
      );

      expect(await screen.findByText('One thing to settle first')).toBeInTheDocument();
      expect(
        screen.getByText(
          '"Migration planning" is saved in your Cases — choose it when you book with CloudPeak again.'
        )
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Your case is saved — we just couldn't lock in the time")
      ).not.toBeInTheDocument();
      // These panels offer no in-dialog retry.
      expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    });

    it('a reservation refused at the meeting hop names the saved case too', async () => {
      await submitWith(
        reservedFailure({ stage: 'meeting', engagementId: 'engagement-7', caseTitle: 'Q3 review' })
      );

      expect(
        await screen.findByText(
          '"Q3 review" is saved in your Cases — choose it when you book with CloudPeak again.'
        )
      ).toBeInTheDocument();
    });

    it('a BAL-478 unfunded refusal at the meeting hop shows the setup panel with the case-saved line', async () => {
      await submitWith({
        ok: false,
        stage: 'meeting',
        code: 'funding_setup_required',
        engagementId: 'engagement-7',
        caseTitle: 'Migration planning',
      });

      expect(await screen.findByText('One setup step first')).toBeInTheDocument();
      expect(
        screen.getByText(
          '"Migration planning" is saved in your Cases — choose it when you book with CloudPeak again.'
        )
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Your case is saved — we just couldn't lock in the time")
      ).toBeNull();
    });

    it('a hop-1 refusal (before any write) shows NO case-saved line', async () => {
      await submitWith(holdFailure());

      await screen.findByText('One thing to settle first');
      expect(document.body.textContent).not.toContain('is saved in your Cases');
    });
  });
});

describe('BookingFlowDialog — inline funding and the on-device draft (BAL-608)', () => {
  type FailureResult = Extract<BookConsultationResult, { ok: false }>;

  const COMPANY = { id: 'company-1', name: 'Northwind Industrial', isActive: true };
  const OTHER_COMPANY = { id: 'company-2', name: 'Acme Corp', isActive: false };
  const SCOPE = { ownerUserId: 'user-1', expertProfileId: 'expert-1' };
  const MANAGER_VIEW = refusedView({
    company: COMPANY,
    wallet: {
      savedCard: null,
      lowBalanceFigures: { topupReloadMinor: 10_000, topupThresholdMinor: 2_000 },
    },
  });
  const MEMBER_VIEW = refusedView({ canManageBilling: false, wallet: null, company: COMPANY });
  const DRAFT: BookingDraft = {
    title: 'Seeded title',
    descriptionHtml: '<p>Seeded description</p>',
    productIds: [],
    guests: [],
    caseSelection: { kind: 'new' },
    companyId: 'company-1',
  };

  const SETUP_FAILURE: FailureResult = {
    ok: false,
    stage: 'funding',
    code: 'funding_setup_required',
    setup: { kind: 'no_wallet', company: COMPANY },
  };
  const SLOT_GONE: FailureResult = {
    ok: false,
    stage: 'meeting',
    code: 'slot_unavailable',
    engagementId: 'engagement-6',
    caseTitle: 'Migration planning',
  };

  function renderDialog(
    entry: React.ComponentProps<typeof BookingFlowDialog>['entry'] = {
      mode: 'chooser',
      context: SINGLE_COMPANY_NO_CASES,
    },
    onClose = vi.fn()
  ): ReturnType<typeof render> {
    return render(
      <BookingFlowDialog
        open
        onClose={onClose}
        expert={EXPERT}
        source="profile"
        entry={entry}
        viewerEmailDomain={null}
        onMessage={vi.fn()}
      />
    );
  }

  async function fillForm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.type(screen.getByLabelText(/^Title/), 'Migration planning');
    await user.type(
      screen.getByLabelText("What you'd like to discuss"),
      'A real problem statement.'
    );
  }

  async function reachConfirm(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByText('Pick 9:00am slot'));
    await fillForm(user);
  }

  describe('the pre-flight and the inline block', () => {
    it('AC1/AC2: reads the pre-flight on Review & confirm, renders the block under the billing line, and never calls Save', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
      renderDialog();

      expect(mockReadBookingFundingAction).not.toHaveBeenCalled();
      await user.click(screen.getByText('Pick 9:00am slot'));

      const block = await screen.findByTestId('funding-block');
      expect(mockReadBookingFundingAction).toHaveBeenCalledWith({
        expertProfileId: 'expert-1',
        slot: {
          startIso: '2026-06-05T09:00:00.000Z',
          endIso: '2026-06-05T09:30:00.000Z',
          durationMinutes: 30,
        },
        caseChoice: { kind: 'new', companyId: 'company-1' },
      });
      const billing = screen.getByText(/Charged only for time used/);
      expect(
        billing.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Confirm & book/ })).not.toBeInTheDocument();
      expect(mockSaveBookingForLaterAction).not.toHaveBeenCalled();
    });

    it('shows the normal Confirm CTA when the pre-flight is clear, unavailable or still loading', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction.mockReturnValue(new Promise(() => {}));
      renderDialog();

      await user.click(screen.getByText('Pick 9:00am slot'));

      expect(screen.getByRole('button', { name: /Confirm & book/ })).toBeInTheDocument();
      expect(screen.queryByTestId('funding-block')).not.toBeInTheDocument();
    });

    it('re-reads when the client changes the time', async () => {
      const user = userEvent.setup();
      renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByRole('button', { name: /Confirm & book/ });
      expect(mockReadBookingFundingAction).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole('button', { name: 'See other times' }));
      await user.click(screen.getByText('Pick 10:00am slot'));

      await vi.waitFor(() => expect(mockReadBookingFundingAction).toHaveBeenCalledTimes(2));
    });

    it('reads against the chosen existing case on the fixed-case entry', async () => {
      mockReadBookingFundingAction.mockResolvedValue(MEMBER_VIEW);
      renderDialog({
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
      });

      expect(await screen.findByTestId('funding-block')).toBeInTheDocument();
      expect(mockReadBookingFundingAction).toHaveBeenCalledWith(
        expect.objectContaining({ caseChoice: { kind: 'existing', engagementId: 'engagement-9' } })
      );
    });

    it('does not call the pre-flight for a multi-company client until a company is chosen', async () => {
      const user = userEvent.setup();
      renderDialog({
        mode: 'chooser',
        context: {
          arm: 'choose_company',
          viewerUserId: 'user-1',
          companies: [
            { id: 'company-1', name: 'Northwind Industrial', logoUrl: null },
            { id: 'company-2', name: 'Acme Corp', logoUrl: null },
          ],
        },
      });

      await user.click(screen.getByText('Pick 9:00am slot'));

      expect(screen.getByRole('button', { name: /Confirm & book/ })).toBeDisabled();
      expect(mockReadBookingFundingAction).not.toHaveBeenCalled();
    });
  });

  describe('pay → credit → book', () => {
    it('AC1: the form fields stay the same mounted node through the funded booking attempt', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
      mockBookConsultationAction.mockResolvedValue(SLOT_GONE);
      renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');
      await fillForm(user);
      const titleInput = screen.getByLabelText(/^Title/);
      const description = screen.getByLabelText("What you'd like to discuss");

      await user.click(screen.getByRole('button', { name: 'Stub funded' }));
      await screen.findByText('This time was just booked by someone else.');

      expect(screen.getByLabelText(/^Title/)).toBe(titleInput);
      expect(screen.getByLabelText("What you'd like to discuss")).toBe(description);
      expect(titleInput).toHaveValue('Migration planning');
    });

    it('AC7: the booking after funding carries the SAME bookingNonce as the refused submit', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction
        .mockResolvedValueOnce({ kind: 'clear' })
        .mockResolvedValue(MANAGER_VIEW);
      mockBookConsultationAction
        .mockResolvedValueOnce(SETUP_FAILURE)
        .mockResolvedValueOnce(successResult());
      renderDialog();
      await reachConfirm(user);

      await user.click(screen.getByRole('button', { name: /Confirm & book/ }));
      await screen.findByTestId('funding-block');
      await user.click(screen.getByRole('button', { name: 'Stub funded' }));

      await vi.waitFor(() => expect(mockBookConsultationAction).toHaveBeenCalledTimes(2));
      const [refused, funded] = mockBookConsultationAction.mock.calls.map(
        ([input]) => input as { bookingNonce: string; slot: unknown; caseChoice: unknown }
      );
      expect(funded?.bookingNonce).toBe(refused?.bookingNonce);
      expect(funded?.slot).toEqual(refused?.slot);
      expect(funded?.caseChoice).toEqual(refused?.caseChoice);
    });

    it('a funded booking that lands moves to the booked step and clears the draft', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
      mockBookConsultationAction.mockResolvedValue(successResult());
      renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'Stub before pay' }));
      expect(readBookingDraft(SCOPE, ['company-1'])?.title).toBe('Migration planning');

      await user.click(screen.getByRole('button', { name: 'Stub funded' }));

      expect(await screen.findByText(/Discuss migration plan/)).toBeInTheDocument();
      expect(readBookingDraft(SCOPE, ['company-1'])).toBeNull();
    });

    it('AC8: slot_unavailable after funding shows the banner with the top-up line, then re-reads the pre-flight', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
      mockBookConsultationAction.mockResolvedValue(SLOT_GONE);
      renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');
      await fillForm(user);
      const readsBefore = mockReadBookingFundingAction.mock.calls.length;

      await user.click(screen.getByRole('button', { name: 'Stub funded' }));

      expect(
        await screen.findByText('This time was just booked by someone else.')
      ).toBeInTheDocument();
      expect(screen.getByText(/Your top-up went through, so .*300/)).toBeInTheDocument();
      expect(
        screen.getByText(/Northwind Industrial/, { selector: 'span.block' })
      ).toBeInTheDocument();
      await vi.waitFor(() =>
        expect(mockReadBookingFundingAction.mock.calls.length).toBeGreaterThan(readsBefore)
      );
    });

    it('slot_unavailable after Pay after shows the card line with no AUD figure', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
      mockBookConsultationAction.mockResolvedValue(SLOT_GONE);
      renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');
      await fillForm(user);

      await user.click(screen.getByRole('button', { name: 'Stub funded pay after' }));

      expect(
        await screen.findByText('This time was just booked by someone else.')
      ).toBeInTheDocument();
      expect(screen.getByText(/set up and ready for the next time you choose/)).toBeInTheDocument();
      expect(screen.queryByText(/top-up went through/)).not.toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/\$\s?\d|AUD/);
    });

    it('a pay_after funding re-submits with the SAME bookingNonce', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction
        .mockResolvedValueOnce({ kind: 'clear' })
        .mockResolvedValue(MANAGER_VIEW);
      mockBookConsultationAction
        .mockResolvedValueOnce(SETUP_FAILURE)
        .mockResolvedValueOnce(successResult());
      renderDialog();
      await reachConfirm(user);

      await user.click(screen.getByRole('button', { name: /Confirm & book/ }));
      await screen.findByTestId('funding-block');
      await user.click(screen.getByRole('button', { name: 'Stub funded pay after' }));

      await vi.waitFor(() => expect(mockBookConsultationAction).toHaveBeenCalledTimes(2));
      const [refused, funded] = mockBookConsultationAction.mock.calls.map(
        ([input]) => input as { bookingNonce: string }
      );
      expect(funded?.bookingNonce).toBe(refused?.bookingNonce);
    });

    it('a landed credit clears the block after a failed booking, leaving the normal CTA', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction
        .mockResolvedValueOnce(MANAGER_VIEW)
        .mockResolvedValue({ kind: 'clear' });
      mockBookConsultationAction.mockResolvedValue(SLOT_GONE);
      renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');
      await fillForm(user);

      await user.click(screen.getByRole('button', { name: 'Stub funded' }));

      expect(await screen.findByRole('button', { name: /Confirm & book/ })).toBeInTheDocument();
      expect(screen.queryByTestId('funding-block')).not.toBeInTheDocument();
    });

    it('onBeforePay validates: with no title it refuses, shows the error and writes no draft', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
      renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');

      await user.click(screen.getByRole('button', { name: 'Stub before pay' }));

      expect(mockBlockBeforePay).toHaveBeenCalledWith(false);
      expect(await screen.findByText('Give this a short title.')).toBeInTheDocument();
      expect(readBookingDraft(SCOPE, ['company-1'])).toBeNull();
    });

    it('onBeforePay on a valid form writes the draft and allows the charge', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
      renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');
      await fillForm(user);

      await user.click(screen.getByRole('button', { name: 'Stub before pay' }));

      expect(mockBlockBeforePay).toHaveBeenCalledWith(true);
      expect(readBookingDraft(SCOPE, ['company-1'])).toEqual(
        expect.objectContaining({ title: 'Migration planning', companyId: 'company-1' })
      );
      const raw = JSON.stringify(Object.entries(globalThis.localStorage));
      expect(raw).not.toContain('startIso');
    });
  });

  describe('submit-time refusals', () => {
    it('a manager of the active company gets the inline block with the case-saved line, not the full panel', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction
        .mockResolvedValueOnce({ kind: 'clear' })
        .mockResolvedValue(MANAGER_VIEW);
      mockBookConsultationAction.mockResolvedValue({
        ...SETUP_FAILURE,
        stage: 'meeting',
        engagementId: 'engagement-6',
        caseTitle: 'Migration planning',
      });
      renderDialog();
      await reachConfirm(user);

      await user.click(screen.getByRole('button', { name: /Confirm & book/ }));

      expect(await screen.findByTestId('funding-block')).toBeInTheDocument();
      expect(screen.getByText('case saved: Migration planning')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Set up billing' })).not.toBeInTheDocument();
    });

    it('a hold refusal re-reads the pre-flight as a refusal so a failed heal reproduces its fallback', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction
        .mockResolvedValueOnce({ kind: 'clear' })
        .mockResolvedValue(refusedView({ ...MANAGER_VIEW, arm: 'hold', topUpNeededMinor: null }));
      mockBookConsultationAction.mockResolvedValue({
        ok: false,
        stage: 'funding',
        code: 'hold_top_up_required',
        balance: {
          variant: 'hold',
          topUpNeededMinor: 27_500,
          reservedBookingCount: null,
          company: COMPANY,
        },
      });
      renderDialog();
      await reachConfirm(user);

      await user.click(screen.getByRole('button', { name: /Confirm & book/ }));

      const block = await screen.findByTestId('funding-block');
      expect(block).toHaveAttribute('data-arm', 'hold');
      expect(mockReadBookingFundingAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ onCoveredHold: 'refuse' })
      );
    });

    it('a non-hold refusal re-reads with onCoveredHold defer', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction
        .mockResolvedValueOnce({ kind: 'clear' })
        .mockResolvedValue(MANAGER_VIEW);
      mockBookConsultationAction.mockResolvedValue(SETUP_FAILURE);
      renderDialog();
      await reachConfirm(user);

      await user.click(screen.getByRole('button', { name: /Confirm & book/ }));
      await screen.findByTestId('funding-block');

      expect(mockReadBookingFundingAction).toHaveBeenLastCalledWith(
        expect.objectContaining({ onCoveredHold: 'defer' })
      );
    });

    it('a refusal the pre-flight now clears leaves the normal CTA, with no panel', async () => {
      const user = userEvent.setup();
      mockBookConsultationAction.mockResolvedValue(SETUP_FAILURE);
      renderDialog();
      await reachConfirm(user);

      await user.click(screen.getByRole('button', { name: /Confirm & book/ }));

      await vi.waitFor(() => expect(mockReadBookingFundingAction).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole('button', { name: /Confirm & book/ })).toBeEnabled();
      expect(screen.queryByText('One setup step first')).not.toBeInTheDocument();
    });

    it('AC10: a billing manager of a NON-active company keeps the setup panel with "Switch to {Co} and top up"', async () => {
      const user = userEvent.setup();
      mockSwitchWorkspaceAction.mockResolvedValue({ success: true });
      mockBookConsultationAction.mockResolvedValue({
        ...SETUP_FAILURE,
        setup: {
          kind: 'no_wallet',
          company: { id: 'company-1', name: 'Acme Corp', isActive: false },
        },
      });
      renderDialog();
      await reachConfirm(user);
      const readsBefore = mockReadBookingFundingAction.mock.calls.length;

      await user.click(screen.getByRole('button', { name: /Confirm & book/ }));

      expect(await screen.findByText('One setup step first')).toBeInTheDocument();
      expect(mockReadBookingFundingAction.mock.calls).toHaveLength(readsBefore);
      await user.click(screen.getByRole('button', { name: 'Switch to Acme Corp and top up' }));

      expect(mockSwitchWorkspaceAction).toHaveBeenCalledWith(companyWorkspaceKey('company-1'));
      await vi.waitFor(() => expect(mockRouterPush).toHaveBeenCalledWith('/billing/top-up'));
      expect(readBookingDraft(SCOPE, ['company-1'])?.title).toBe('Migration planning');
    });

    it('AC10: a hold figure above the single top-up maximum keeps BookingBalancePanel', async () => {
      const user = userEvent.setup();
      mockBookConsultationAction.mockResolvedValue({
        ok: false,
        stage: 'funding',
        code: 'hold_top_up_required',
        balance: {
          variant: 'hold',
          topUpNeededMinor: TOP_UP_LIMITS_MINOR.max + TOP_UP_LIMITS_MINOR.step,
          reservedBookingCount: null,
          company: COMPANY,
        },
      });
      renderDialog();
      await reachConfirm(user);
      const readsBefore = mockReadBookingFundingAction.mock.calls.length;

      await user.click(screen.getByRole('button', { name: /Confirm & book/ }));

      expect(await screen.findByText('One thing to settle first')).toBeInTheDocument();
      expect(screen.getByText(/top-ups totalling/)).toBeInTheDocument();
      expect(mockReadBookingFundingAction.mock.calls).toHaveLength(readsBefore);
      expect(screen.queryByTestId('funding-block')).not.toBeInTheDocument();
    });

    it('the balance panel for a non-active company writes the draft before it switches', async () => {
      const user = userEvent.setup();
      mockSwitchWorkspaceAction.mockResolvedValue({ success: true });
      mockBookConsultationAction.mockResolvedValue({
        ok: false,
        stage: 'funding',
        code: 'reserved_top_up_required',
        balance: {
          variant: 'reserved',
          topUpNeededMinor: 7_500,
          reservedBookingCount: 2,
          company: OTHER_COMPANY,
        },
      });
      renderDialog();
      await reachConfirm(user);

      await user.click(screen.getByRole('button', { name: /Confirm & book/ }));
      await user.click(
        await screen.findByRole('button', { name: /Switch to Acme Corp and top up/ })
      );

      expect(readBookingDraft(SCOPE, ['company-1'])?.title).toBe('Migration planning');
    });

    it('a pre-flight that cannot be read falls back to the full panel for a member refusal', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction.mockResolvedValue({ kind: 'unavailable' });
      mockBookConsultationAction.mockResolvedValue({
        ok: false,
        stage: 'funding',
        code: 'funding_admins_notified',
        setup: { kind: 'no_wallet', company: COMPANY },
      });
      renderDialog();
      await reachConfirm(user);

      await user.click(screen.getByRole('button', { name: /Confirm & book/ }));

      expect(await screen.findByText('One setup step first')).toBeInTheDocument();
    });
  });

  describe('Save and finish later', () => {
    async function openMemberBlock(
      user: ReturnType<typeof userEvent.setup>,
      onClose = vi.fn()
    ): Promise<void> {
      mockReadBookingFundingAction.mockResolvedValue(MEMBER_VIEW);
      renderDialog(undefined, onClose);
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');
    }

    it('saves, tracks, toasts and shows the saved-for-later view; closing it fires no ABANDONED', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      mockSaveBookingForLaterAction.mockResolvedValue({ ok: true });
      await openMemberBlock(user, onClose);
      await fillForm(user);

      await user.click(screen.getByRole('button', { name: 'Stub save' }));

      expect(await screen.findByText('Saved for later')).toBeInTheDocument();
      expect(screen.getByText(/Northwind Industrial's billing admins/)).toBeInTheDocument();
      expect(mockSaveBookingForLaterAction).toHaveBeenCalledWith(
        expect.objectContaining({ expertProfileId: 'expert-1' })
      );
      expect(track).toHaveBeenCalledWith('booking_saved_for_later', {});
      expect(toast.success).toHaveBeenCalledWith('Saved for later');
      expect(readBookingDraft(SCOPE, ['company-1'])?.title).toBe('Migration planning');

      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalled();
      expect(track).not.toHaveBeenCalledWith('booking_abandoned', expect.anything());
    });

    it('the Done button closes the saved view', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      mockSaveBookingForLaterAction.mockResolvedValue({ ok: true });
      await openMemberBlock(user, onClose);
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'Stub save' }));

      await user.click(await screen.findByRole('button', { name: 'Done' }));

      expect(onClose).toHaveBeenCalled();
    });

    it('does not save an invalid form', async () => {
      const user = userEvent.setup();
      await openMemberBlock(user);

      await user.click(screen.getByRole('button', { name: 'Stub save' }));

      expect(mockSaveBookingForLaterAction).not.toHaveBeenCalled();
      expect(await screen.findByText('Give this a short title.')).toBeInTheDocument();
    });

    it('not_refused says it can be booked now and re-reads the pre-flight', async () => {
      const user = userEvent.setup();
      mockSaveBookingForLaterAction.mockResolvedValue({ ok: false, reason: 'not_refused' });
      await openMemberBlock(user);
      await fillForm(user);
      const readsBefore = mockReadBookingFundingAction.mock.calls.length;

      await user.click(screen.getByRole('button', { name: 'Stub save' }));

      await vi.waitFor(() =>
        expect(toast.info).toHaveBeenCalledWith('Good news — this can be booked now.')
      );
      await vi.waitFor(() =>
        expect(mockReadBookingFundingAction.mock.calls.length).toBeGreaterThan(readsBefore)
      );
      expect(screen.queryByText('Saved for later')).not.toBeInTheDocument();
    });

    it.each([
      ['refused', { ok: false, reason: 'refused' }],
      ['failed', { ok: false, reason: 'failed' }],
    ])(
      'a %s save toasts the keep-on-device error and stays on the form',
      async (_label, result) => {
        const user = userEvent.setup();
        mockSaveBookingForLaterAction.mockResolvedValue(result);
        await openMemberBlock(user);
        await fillForm(user);

        await user.click(screen.getByRole('button', { name: 'Stub save' }));

        await vi.waitFor(() =>
          expect(toast.error).toHaveBeenCalledWith(
            "We couldn't let your billing admins know just now. What you typed is still saved on this device."
          )
        );
        expect(screen.getByTestId('funding-block')).toBeInTheDocument();
      }
    );

    it('a thrown save is captured and toasts the same error', async () => {
      const user = userEvent.setup();
      mockSaveBookingForLaterAction.mockRejectedValue(new Error('network'));
      await openMemberBlock(user);
      await fillForm(user);

      await user.click(screen.getByRole('button', { name: 'Stub save' }));

      await vi.waitFor(() => expect(mockCaptureException).toHaveBeenCalled());
      expect(toast.error).toHaveBeenCalled();
    });
  });

  describe('landed top-up follow-ups, locks and focus', () => {
    async function fundAndFail(
      user: ReturnType<typeof userEvent.setup>,
      failure: BookConsultationResult
    ): Promise<void> {
      mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
      mockBookConsultationAction.mockResolvedValue(failure);
      renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'Stub funded' }));
    }

    it('a hard failure after a landed top-up says the top-up is in the balance and never "Nothing was charged"', async () => {
      const user = userEvent.setup();
      await fundAndFail(user, { ok: false, stage: 'validation', code: 'invalid_request' });

      expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
      expect(screen.getByText(/Your top-up went through and .*300.* is in/)).toBeInTheDocument();
      expect(screen.getByText(/Trying again won't charge you again/)).toBeInTheDocument();
      expect(document.body.textContent).not.toContain('Nothing was charged');
    });

    it('a partial failure after a landed top-up carries the same follow-up', async () => {
      const user = userEvent.setup();
      await fundAndFail(user, {
        ok: false,
        stage: 'meeting',
        code: 'invalid_request',
        engagementId: 'engagement-6',
        caseTitle: 'Migration planning',
      });

      expect(await screen.findByText(/we just couldn't lock in the time/)).toBeInTheDocument();
      expect(screen.getByText(/Your top-up went through and .*300/)).toBeInTheDocument();
    });

    it('a session-expired panel after a landed top-up says nothing more will be charged', async () => {
      const user = userEvent.setup();
      await fundAndFail(user, { ok: false, stage: 'validation', code: 'session_expired' });

      expect(await screen.findByText('Sign in to finish booking')).toBeInTheDocument();
      expect(screen.getByText(/Sign in and you won't be charged again/)).toBeInTheDocument();
    });

    it('a hard failure with no top-up keeps the default no-charge copy', async () => {
      const user = userEvent.setup();
      mockBookConsultationAction.mockResolvedValue({
        ok: false,
        stage: 'validation',
        code: 'invalid_request',
      });
      renderDialog();
      await reachConfirm(user);
      await user.click(await screen.findByRole('button', { name: /Confirm & book/ }));

      expect(await screen.findByText(/Nothing was charged/)).toBeInTheDocument();
    });

    it('a re-read that clears after a refused submit toasts and leaves the CTA live', async () => {
      const user = userEvent.setup();
      mockBookConsultationAction.mockResolvedValue(SETUP_FAILURE);
      renderDialog();
      await reachConfirm(user);

      await user.click(screen.getByRole('button', { name: /Confirm & book/ }));

      await vi.waitFor(() =>
        expect(toast.info).toHaveBeenCalledWith(
          'Your balance now covers this booking — press Confirm & book.'
        )
      );
      expect(screen.getByRole('button', { name: /Confirm & book/ })).toBeEnabled();
    });

    it('after a credited top-up whose booking failed, the cleared pre-flight books with no new payment', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction
        .mockResolvedValueOnce(MANAGER_VIEW)
        .mockResolvedValue({ kind: 'clear' });
      mockBookConsultationAction
        .mockResolvedValueOnce(SLOT_GONE)
        .mockResolvedValueOnce(successResult());
      renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');
      await fillForm(user);
      await user.click(screen.getByRole('button', { name: 'Stub funded' }));
      await user.click(await screen.findByRole('button', { name: /Confirm & book/ }));

      expect(await screen.findByText(/Discuss migration plan/)).toBeInTheDocument();
      expect(mockBookConsultationAction).toHaveBeenCalledTimes(2);
    });

    it('locks the time, the case and the company while the block reports a payment under way', async () => {
      const user = userEvent.setup();
      writeBookingDraft(SCOPE, DRAFT);
      mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
      renderDialog({
        mode: 'chooser',
        context: {
          arm: 'choose_company',
          viewerUserId: 'user-1',
          companies: [
            { id: 'company-1', name: 'Northwind Industrial', logoUrl: null },
            { id: 'company-2', name: 'Acme Corp', logoUrl: null },
          ],
        },
      });
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');
      expect(screen.getByRole('button', { name: 'See other times' })).toBeEnabled();
      expect(screen.getByRole('combobox')).toBeEnabled();

      await user.click(screen.getByRole('button', { name: 'Stub busy' }));

      expect(screen.getByRole('button', { name: 'See other times' })).toBeDisabled();
      expect(screen.getByRole('combobox')).toBeDisabled();
    });

    it('passes whether a draft is kept: yes for the chooser, no for the fixed case', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction.mockResolvedValue(MEMBER_VIEW);
      const { unmount } = renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));
      expect(await screen.findByText('draft kept')).toBeInTheDocument();
      unmount();

      renderDialog({
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
      });
      expect(await screen.findByText('no draft')).toBeInTheDocument();
    });

    it('the saved-for-later view drops the on-device claim when no draft was written', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction.mockResolvedValue(MEMBER_VIEW);
      mockSaveBookingForLaterAction.mockResolvedValue({ ok: true });
      renderDialog({
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
      });
      await screen.findByTestId('funding-block');

      await user.click(screen.getByRole('button', { name: 'Stub save' }));

      expect(await screen.findByText('Saved for later')).toBeInTheDocument();
      expect(screen.queryByText(/saved on this device/)).not.toBeInTheDocument();
    });

    it('Save on an invalid form focuses the first invalid field', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
      renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');

      await user.click(screen.getByRole('button', { name: 'Stub before pay' }));
      expect(screen.getByLabelText(/^Title/)).toHaveFocus();

      await user.type(screen.getByLabelText(/^Title/), 'Migration planning');
      await user.click(screen.getByRole('button', { name: 'Stub before pay' }));
      expect(screen.getByLabelText("What you'd like to discuss")).toHaveFocus();
    });

    it('Clear toasts that the saved details are gone', async () => {
      const user = userEvent.setup();
      writeBookingDraft(SCOPE, DRAFT);
      renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));

      await user.click(screen.getByRole('button', { name: 'Clear' }));

      expect(toast.success).toHaveBeenCalledWith('Cleared what was saved on this device.');
    });

    it('disables Confirm & book with a busy mark while the pre-flight is answering', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction.mockReturnValue(new Promise(() => {}));
      renderDialog();

      await user.click(screen.getByText('Pick 9:00am slot'));

      const confirm = screen.getByRole('button', { name: /Confirm & book/ });
      expect(confirm).toBeDisabled();
      expect(confirm).toHaveAttribute('aria-busy', 'true');
    });
  });

  describe('a top-up in flight holds the dialog open', () => {
    it.each([
      ['dialog', false],
      ['sheet', true],
    ])('Escape while a top-up is in flight is ignored (%s)', async (_label, mobile) => {
      mockIsMobile.mockReturnValue(mobile);
      const user = userEvent.setup();
      const onClose = vi.fn();
      mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
      renderDialog(undefined, onClose);
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');

      await user.click(screen.getByRole('button', { name: 'Stub in flight' }));
      await user.keyboard('{Escape}');

      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId('funding-block')).toBeInTheDocument();
    });

    it.each([
      ['dialog', false],
      ['sheet', true],
    ])(
      'Escape closes when the block is busy but nothing is in flight, as after an unconfirmed credit (%s)',
      async (_label, mobile) => {
        mockIsMobile.mockReturnValue(mobile);
        const user = userEvent.setup();
        const onClose = vi.fn();
        mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
        renderDialog(undefined, onClose);
        await user.click(screen.getByText('Pick 9:00am slot'));
        await screen.findByTestId('funding-block');

        await user.click(screen.getByRole('button', { name: 'Stub busy' }));
        await user.keyboard('{Escape}');

        expect(onClose).toHaveBeenCalledTimes(1);
      }
    );

    it('a click on a Stripe frame outside the modal never dismisses it, even when idle', async () => {
      const user = userEvent.setup();
      const onClose = vi.fn();
      mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
      renderDialog(undefined, onClose);
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');
      const stripeFrame = document.createElement('iframe');
      stripeFrame.setAttribute('name', '__privateStripeFrame7');
      document.body.append(stripeFrame);

      fireEvent.pointerDown(stripeFrame);
      fireEvent.focusIn(stripeFrame);

      expect(onClose).not.toHaveBeenCalled();
      stripeFrame.remove();
    });

    it.each([
      ['dialog', false],
      ['sheet', true],
    ])('Escape closes while the funding block is idle (%s)', async (_label, mobile) => {
      mockIsMobile.mockReturnValue(mobile);
      const user = userEvent.setup();
      const onClose = vi.fn();
      mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
      renderDialog(undefined, onClose);
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');

      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('a funded booking refused again', () => {
    it('re-reads the pre-flight once, not once per caller', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
      mockBookConsultationAction.mockResolvedValue(SETUP_FAILURE);
      renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');
      await fillForm(user);
      const readsBefore = mockReadBookingFundingAction.mock.calls.length;

      await user.click(screen.getByRole('button', { name: 'Stub funded' }));

      await vi.waitFor(() => expect(mockBookConsultationAction).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(mockReadBookingFundingAction).toHaveBeenCalledTimes(readsBefore + 1)
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(mockReadBookingFundingAction).toHaveBeenCalledTimes(readsBefore + 1);
      expect(screen.getByTestId('funding-block')).toBeInTheDocument();
    });

    it('still re-reads the pre-flight once when the booking fails for another reason', async () => {
      const user = userEvent.setup();
      mockReadBookingFundingAction.mockResolvedValue(MANAGER_VIEW);
      mockBookConsultationAction.mockResolvedValue(SLOT_GONE);
      renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));
      await screen.findByTestId('funding-block');
      await fillForm(user);
      const readsBefore = mockReadBookingFundingAction.mock.calls.length;

      await user.click(screen.getByRole('button', { name: 'Stub funded' }));

      await vi.waitFor(() =>
        expect(mockReadBookingFundingAction).toHaveBeenCalledTimes(readsBefore + 1)
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(mockReadBookingFundingAction).toHaveBeenCalledTimes(readsBefore + 1);
    });
  });

  describe('AC9: the on-device draft', () => {
    it('restores a seeded draft on open, starts on pick_time, shows the notice on confirm, and Clear empties the fields', async () => {
      const user = userEvent.setup();
      writeBookingDraft(SCOPE, DRAFT);
      renderDialog();

      expect(screen.getByText('Pick 9:00am slot')).toBeInTheDocument();
      expect(screen.queryByText('Filled in from your last visit')).not.toBeInTheDocument();

      await user.click(screen.getByText('Pick 9:00am slot'));

      expect(screen.getByLabelText(/^Title/)).toHaveValue('Seeded title');
      expect(screen.getByLabelText("What you'd like to discuss")).toHaveValue('Seeded description');
      expect(screen.getByText('Filled in from your last visit')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Clear' }));

      expect(screen.getByLabelText(/^Title/)).toHaveValue('');
      expect(screen.getByLabelText("What you'd like to discuss")).toHaveValue('');
      expect(screen.queryByText('Filled in from your last visit')).not.toBeInTheDocument();
      expect(readBookingDraft(SCOPE, ['company-1'])).toBeNull();
    });

    it('a successful booking clears the draft', async () => {
      const user = userEvent.setup();
      writeBookingDraft(SCOPE, DRAFT);
      mockBookConsultationAction.mockResolvedValue(successResult());
      renderDialog();
      await user.click(screen.getByText('Pick 9:00am slot'));

      await user.click(screen.getByRole('button', { name: /Confirm & book/ }));

      await screen.findByText(/Discuss migration plan/);
      expect(readBookingDraft(SCOPE, ['company-1'])).toBeNull();
    });

    it("never restores another user's draft", async () => {
      const user = userEvent.setup();
      writeBookingDraft({ ownerUserId: 'user-2', expertProfileId: 'expert-1' }, DRAFT);
      renderDialog();

      await user.click(screen.getByText('Pick 9:00am slot'));

      expect(screen.getByLabelText(/^Title/)).toHaveValue('');
    });

    it('the fixed-case entry neither reads nor restores a draft', async () => {
      writeBookingDraft(SCOPE, DRAFT);
      renderDialog({
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
      });

      expect(screen.queryByText('Filled in from your last visit')).not.toBeInTheDocument();
      expect(readBookingDraft(SCOPE, ['company-1'])?.title).toBe('Seeded title');
    });

    it('restores an existing-case choice only while that case is still open', async () => {
      const user = userEvent.setup();
      writeBookingDraft(SCOPE, {
        ...DRAFT,
        caseSelection: { kind: 'existing', engagementId: 'engagement-3' },
      });
      renderDialog({
        mode: 'chooser',
        context: {
          ...(SINGLE_COMPANY_NO_CASES as Extract<BookingContext, { arm: 'single_company' }>),
          openCases: [
            {
              engagementId: 'engagement-3',
              title: 'Flow interview loop',
              createdAt: '2026-06-01T00:00:00.000Z',
              lastActivityAt: '2026-06-02T00:00:00.000Z',
              consultationCount: 2,
            },
          ],
        },
      });

      await user.click(screen.getByText('Pick 9:00am slot'));

      expect(screen.getByRole('combobox', { name: 'Which case is this for?' })).toHaveTextContent(
        'Flow interview loop'
      );
      expect(screen.queryByLabelText(/^Title/)).not.toBeInTheDocument();
    });

    it('falls back to a new case when the drafted case is no longer open', async () => {
      const user = userEvent.setup();
      writeBookingDraft(SCOPE, {
        ...DRAFT,
        caseSelection: { kind: 'existing', engagementId: 'engagement-gone' },
      });
      renderDialog();

      await user.click(screen.getByText('Pick 9:00am slot'));

      expect(screen.getByLabelText(/^Title/)).toHaveValue('Seeded title');
    });

    it('a multi-company draft re-selects its company and re-reads that company’s open cases', async () => {
      const user = userEvent.setup();
      writeBookingDraft(SCOPE, { ...DRAFT, companyId: 'company-2' });
      renderDialog({
        mode: 'chooser',
        context: {
          arm: 'choose_company',
          viewerUserId: 'user-1',
          companies: [
            { id: 'company-1', name: 'Northwind Industrial', logoUrl: null },
            { id: 'company-2', name: 'Acme Corp', logoUrl: null },
          ],
        },
      });

      await user.click(screen.getByText('Pick 9:00am slot'));

      expect(vi.mocked(refetchOpenCasesAction)).toHaveBeenCalledWith({
        expertProfileId: 'expert-1',
        companyId: 'company-2',
      });
      expect(screen.getByLabelText(/^Title/)).toHaveValue('Seeded title');
      expect(screen.getByRole('combobox')).toHaveTextContent('Acme Corp');
    });
  });
});
