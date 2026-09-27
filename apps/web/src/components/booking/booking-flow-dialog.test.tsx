import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { act, render, screen } from '@/test/utils';
import { toast } from 'sonner';
import { track } from '@/lib/analytics';
import type { BookConsultationResult } from '@/lib/booking/actions/types';
import { SESSION_EXPIRED_MESSAGE } from '@/lib/auth/auth-error-copy';
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
  mockSwitchWorkspaceAction.mockReset();
  mockCaptureException.mockClear();
  mockCaptureMessage.mockClear();
  vi.mocked(track).mockClear();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
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
