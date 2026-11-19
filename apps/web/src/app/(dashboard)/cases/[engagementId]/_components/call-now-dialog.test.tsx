import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { render, screen, waitFor } from '@/test/utils';
import { track, CALL_NOW_EVENTS } from '@/lib/analytics';
import { CALL_NOW_COPY, START_FAILURE_COPY } from '@/lib/call-now/call-now-copy';
import type { CallNowConfirmView } from '@/lib/call-now/call-now-types';
import type { StartCallNowResult } from '../_actions/_types/call-now-action-types';
import { CallNowDialog } from './call-now-dialog';

const { mockPush, mockRefresh, mockStart, mockIsMobile } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockRefresh: vi.fn(),
  mockStart: vi.fn(),
  mockIsMobile: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh, replace: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mockIsMobile() }));
vi.mock('../_actions/start-call-now', () => ({
  startCallNowAction: (...a: unknown[]) => mockStart(...a),
}));

// The funding step has its own suite; here it is a witness for what the dialog hands it.
const { fundingProps } = vi.hoisted(() => ({ fundingProps: vi.fn() }));
vi.mock('@/components/balo/call-now/call-now-funding-step', () => ({
  CallNowFundingStep: (props: {
    request: unknown;
    callerLens: string;
    fundingCode: string;
    onFunded: () => Promise<boolean>;
    onBack: () => void;
    onBookInstead: (() => void) | null;
  }) => {
    fundingProps(props);
    return (
      <div data-testid="funding-step">
        <button type="button" onClick={() => props.onFunded().catch(() => undefined)}>
          funded
        </button>
        <button type="button" onClick={props.onBack}>
          Back
        </button>
        {props.onBookInstead !== null && (
          <button type="button" onClick={props.onBookInstead}>
            Book a time
          </button>
        )}
      </div>
    );
  },
}));

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const MEETING_ID = 'm0000000-0000-4000-8000-000000000002';
const RING_ID = 'r0000000-0000-4000-8000-000000000003';
const IN_PLACE_ID = 'a0000000-0000-4000-8000-000000000004';

type ClientTerms = Extract<CallNowConfirmView, { kind: 'client_terms' }>;

const CLIENT: ClientTerms = {
  kind: 'client_terms',
  engagementId: ENGAGEMENT_ID,
  expertProfileId: 'p-1',
  calleeOnline: true,
  rateLine: 'A$125.00/min · 15-minute minimum',
  inPlaceCandidate: null,
  bookInPage: true,
};

const EXPERT: CallNowConfirmView = { kind: 'expert_notice', engagementId: ENGAGEMENT_ID };

const OK: StartCallNowResult = { ok: true, meetingId: MEETING_ID, ringId: RING_ID };

const ATTEMPT_ID = 'a1111111-1111-4111-8111-111111111111';

/** The properties every caller funnel event carries, for the default (desktop, client) render. */
const BASE_EVENT = { attempt_id: ATTEMPT_ID, surface: 'desktop' } as const;

function renderDialog(
  confirm: CallNowConfirmView = CLIENT,
  over: { onBookTime?: (() => void) | null; onOpenChange?: (open: boolean) => void } = {}
) {
  const onOpenChange = over.onOpenChange ?? vi.fn();
  const onBookTime = over.onBookTime === undefined ? vi.fn() : over.onBookTime;
  render(
    <CallNowDialog
      attemptId={ATTEMPT_ID}
      calleeOnline={confirm.kind === 'client_terms' && confirm.calleeOnline}
      open
      onOpenChange={onOpenChange}
      calleeLabel={confirm.kind === 'client_terms' ? 'Amara' : 'Northwind Industrial'}
      confirm={confirm}
      onBookTime={onBookTime}
    />
  );
  return { onOpenChange, onBookTime };
}

describe('CallNowDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsMobile.mockReturnValue(false);
    mockStart.mockResolvedValue(OK);
  });

  describe('confirm copy', () => {
    it('shows the online client confirm with the rate line, Call now filled and Not now', () => {
      renderDialog();
      expect(screen.getByRole('dialog', { name: 'Call Amara now?' })).toBeInTheDocument();
      expect(screen.getByText(/Amara is online\./)).toBeInTheDocument();
      expect(
        screen.getByText('A$125.00/min · 15-minute minimum. The timer starts when you’re both in.')
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Call now' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    });

    it('drops the rate sentence when the expert has no rate', () => {
      renderDialog({ ...CLIENT, rateLine: null });
      expect(screen.getByText('The timer starts when you’re both in.')).toBeInTheDocument();
    });

    it('offers Book a time (filled) and Call anyway when the callee is offline', () => {
      renderDialog({ ...CLIENT, calleeOnline: false });
      expect(screen.getByText(/Amara isn’t online right now\./)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Book a time' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Call anyway' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Call now' })).not.toBeInTheDocument();
    });

    it('offers Not now and Call anyway when offline with nowhere to book', () => {
      renderDialog({ ...CLIENT, calleeOnline: false, bookInPage: false });
      expect(screen.queryByRole('button', { name: 'Book a time' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Call anyway' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    });

    it('offers no Book a time when the surface gives it nowhere to go', () => {
      renderDialog({ ...CLIENT, calleeOnline: false }, { onBookTime: null });
      expect(screen.queryByRole('button', { name: 'Book a time' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Call anyway' })).toBeInTheDocument();
    });

    it('shows the expert notice with no rate or per-minute figure', () => {
      renderDialog(EXPERT);
      expect(
        screen.getByText(/We’ll let Northwind Industrial know you’re calling/)
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Call now' })).toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(/\/min|A\$/);
    });

    it('never offers a Cancel button', () => {
      renderDialog();
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });

    it('renders as a bottom sheet on a phone', () => {
      mockIsMobile.mockReturnValue(true);
      renderDialog();
      expect(screen.getByRole('dialog', { name: 'Call Amara now?' })).toHaveAttribute(
        'data-slot',
        'sheet-content'
      );
    });
  });

  describe('same-day choice', () => {
    const WITH_CANDIDATE: ClientTerms = {
      ...CLIENT,
      inPlaceCandidate: { meetingId: IN_PLACE_ID, scheduledStartIso: '2026-11-19T10:00:00.000Z' },
    };

    it('is ticked by default and sends the meeting id', async () => {
      renderDialog(WITH_CANDIDATE);
      expect(screen.getByRole('checkbox')).toBeChecked();

      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));

      expect(mockStart).toHaveBeenCalledWith({
        engagementId: ENGAGEMENT_ID,
        attemptId: ATTEMPT_ID,
        inPlaceOfMeetingId: IN_PLACE_ID,
      });
      expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.CONFIRMED, {
        ...BASE_EVENT,
        lens: 'client',
        callee_presence: 'online',
        choice: 'call_now',
        in_place_of_booking: true,
      });
    });

    it('sends no meeting id once unticked', async () => {
      renderDialog(WITH_CANDIDATE);
      await userEvent.click(screen.getByRole('checkbox'));
      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));

      expect(mockStart).toHaveBeenCalledWith({
        engagementId: ENGAGEMENT_ID,
        attemptId: ATTEMPT_ID,
      });
      expect(track).toHaveBeenCalledWith(
        CALL_NOW_EVENTS.CONFIRMED,
        expect.objectContaining({ in_place_of_booking: false })
      );
    });

    it('is absent with no candidate and on the expert arm', () => {
      const { unmount } = render(
        <CallNowDialog
          attemptId={ATTEMPT_ID}
          calleeOnline
          open
          onOpenChange={vi.fn()}
          calleeLabel="Amara"
          confirm={CLIENT}
          onBookTime={null}
        />
      );
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      unmount();
      renderDialog(EXPERT);
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    });
  });

  describe('starting the call', () => {
    it('asks for browser notification permission on the Call now click', async () => {
      const requestPermission = vi.fn().mockResolvedValue('granted');
      vi.stubGlobal('Notification', { permission: 'default', requestPermission });
      try {
        renderDialog();
        await userEvent.click(screen.getByRole('button', { name: 'Call now' }));
        expect(requestPermission).toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('pushes the caller to the call room on success', async () => {
      renderDialog();
      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));

      await waitFor(() =>
        expect(mockPush).toHaveBeenCalledWith(`/meetings/${MEETING_ID}/call?ring=${RING_ID}`)
      );
      expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.CONFIRMED, {
        ...BASE_EVENT,
        lens: 'client',
        callee_presence: 'online',
        choice: 'call_now',
        in_place_of_booking: false,
      });
    });

    it('tracks the expert lens and the loader’s offline presence on the expert arm', async () => {
      renderDialog(EXPERT);
      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));
      await waitFor(() => expect(mockPush).toHaveBeenCalled());
      expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.CONFIRMED, {
        ...BASE_EVENT,
        lens: 'expert',
        callee_presence: 'offline',
        choice: 'call_now',
        in_place_of_booking: false,
      });
    });

    it('tracks Call anyway as the commit from the offline confirm', async () => {
      renderDialog({ ...CLIENT, calleeOnline: false });
      await userEvent.click(screen.getByRole('button', { name: 'Call anyway' }));
      await waitFor(() => expect(mockPush).toHaveBeenCalled());
      expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.CONFIRMED, {
        ...BASE_EVENT,
        lens: 'client',
        callee_presence: 'offline',
        choice: 'call_anyway',
        in_place_of_booking: false,
      });
    });

    it('tracks the commit on the click, before the start action resolves', async () => {
      mockStart.mockReturnValue(new Promise<StartCallNowResult>(() => undefined));
      renderDialog();
      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));

      expect(mockStart).toHaveBeenCalledTimes(1);
      expect(track).toHaveBeenCalledWith(
        CALL_NOW_EVENTS.CONFIRMED,
        expect.objectContaining({ attempt_id: ATTEMPT_ID })
      );
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('tracks the commit even when the start is then refused', async () => {
      mockStart.mockResolvedValue({ ok: false, code: 'venue_unavailable' });
      renderDialog();
      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalled());
      expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.CONFIRMED, expect.anything());
    });

    it('reports the mobile surface on a phone', async () => {
      mockIsMobile.mockReturnValue(true);
      renderDialog();
      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));
      expect(track).toHaveBeenCalledWith(
        CALL_NOW_EVENTS.CONFIRMED,
        expect.objectContaining({ surface: 'mobile' })
      );
    });

    it('marks the Call now button busy and announces the call while starting', async () => {
      mockStart.mockReturnValue(new Promise<StartCallNowResult>(() => undefined));
      renderDialog();
      expect(screen.getByRole('status')).toHaveTextContent('');
      expect(screen.getByRole('button', { name: 'Call now' })).toHaveAttribute(
        'aria-busy',
        'false'
      );

      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));

      expect(screen.getByRole('button', { name: 'Call now' })).toHaveAttribute('aria-busy', 'true');
      const status = screen.getByRole('status');
      expect(status).toHaveAttribute('aria-live', 'polite');
      expect(status).toHaveClass('sr-only');
      expect(status).toHaveTextContent('Calling Amara');
    });

    it('locks the dialog while starting: buttons disabled and the close is ignored', async () => {
      let resolve: (value: StartCallNowResult) => void = () => undefined;
      mockStart.mockReturnValue(
        new Promise<StartCallNowResult>((r) => {
          resolve = r;
        })
      );
      const { onOpenChange } = renderDialog();

      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));

      expect(screen.getByRole('button', { name: 'Call now' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Not now' })).toBeDisabled();
      await userEvent.keyboard('{Escape}');
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      expect(track).not.toHaveBeenCalledWith(CALL_NOW_EVENTS.ABANDONED, expect.anything());

      resolve(OK);
      await waitFor(() => expect(mockPush).toHaveBeenCalled());
    });

    it.each([
      ['venue_unavailable', START_FAILURE_COPY.venue_unavailable],
      ['rate_limited', START_FAILURE_COPY.rate_limited],
      ['session_expired', START_FAILURE_COPY.session_expired],
      ['funding_unavailable', START_FAILURE_COPY.funding_unavailable],
      ['impersonation_refused', START_FAILURE_COPY.failed],
      ['failed', START_FAILURE_COPY.failed],
    ] as const)('toasts a %s failure and returns to the confirm', async (code, copy) => {
      mockStart.mockResolvedValue({ ok: false, code });
      const { onOpenChange } = renderDialog();

      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(copy));
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Call now' })).toBeEnabled();
    });

    it.each([['unavailable'], ['in_place_not_eligible']] as const)(
      'toasts %s, closes and refreshes the page',
      async (code) => {
        mockStart.mockResolvedValue({ ok: false, code });
        const { onOpenChange } = renderDialog();

        await userEvent.click(screen.getByRole('button', { name: 'Call now' }));

        await waitFor(() => expect(toast.error).toHaveBeenCalledWith(START_FAILURE_COPY[code]));
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(mockRefresh).toHaveBeenCalled();
      }
    );

    it('treats a thrown action as a generic failure', async () => {
      mockStart.mockRejectedValue(new Error('boom'));
      renderDialog();
      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(START_FAILURE_COPY.failed));
    });
  });

  describe('leaving', () => {
    it('Not now tracks the confirm abandon via not_now and closes', async () => {
      const { onOpenChange } = renderDialog();
      await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
      expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.ABANDONED, {
        ...BASE_EVENT,
        lens: 'client',
        callee_presence: 'online',
        step: 'confirm',
        via: 'not_now',
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('the close control tracks the abandon via close', async () => {
      const { onOpenChange } = renderDialog();
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.ABANDONED, {
        ...BASE_EVENT,
        lens: 'client',
        callee_presence: 'online',
        step: 'confirm',
        via: 'close',
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('Escape counts as close', async () => {
      renderDialog();
      await userEvent.keyboard('{Escape}');
      expect(track).toHaveBeenCalledWith(
        CALL_NOW_EVENTS.ABANDONED,
        expect.objectContaining({ via: 'close' })
      );
    });

    it('Book a time closes the dialog and asks the surface to open booking', async () => {
      const { onOpenChange, onBookTime } = renderDialog({ ...CLIENT, calleeOnline: false });
      await userEvent.click(screen.getByRole('button', { name: 'Book a time' }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onBookTime).toHaveBeenCalledTimes(1);
      expect(mockStart).not.toHaveBeenCalled();
    });

    it('Book a time on the offline confirm tracks the book-instead click and no abandon', async () => {
      renderDialog({ ...CLIENT, calleeOnline: false });
      await userEvent.click(screen.getByRole('button', { name: 'Book a time' }));
      expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.BOOK_INSTEAD_CLICKED, {
        ...BASE_EVENT,
        lens: 'client',
        from: 'confirm_offline',
      });
      expect(track).not.toHaveBeenCalledWith(CALL_NOW_EVENTS.ABANDONED, expect.anything());
    });
  });

  describe('credit gate', () => {
    const FUNDING: StartCallNowResult = {
      ok: false,
      code: 'funding',
      fundingCode: 'booking_unfunded',
    };

    async function openFunding(confirm: CallNowConfirmView = CLIENT) {
      mockStart.mockResolvedValueOnce(FUNDING);
      const handles = renderDialog(confirm);
      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));
      await screen.findByTestId('funding-step');
      return handles;
    }

    it('opens the funding step with a 15-minute request for this case and the client lens', async () => {
      await openFunding();

      const [props] = fundingProps.mock.calls.at(-1) ?? [];
      expect(props.callerLens).toBe('client');
      expect(props.fundingCode).toBe('booking_unfunded');
      expect(props).not.toHaveProperty('suggestedTopUpMinor');
      expect(props.request).toMatchObject({
        expertProfileId: 'p-1',
        slot: { durationMinutes: 15 },
        caseChoice: { kind: 'existing', engagementId: ENGAGEMENT_ID },
      });
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });

    it('does not emit the gate-shown event itself — the step owns it', async () => {
      await openFunding();
      expect(track).not.toHaveBeenCalledWith(CALL_NOW_EVENTS.FUNDING_GATE_SHOWN, expect.anything());
    });

    it('retries the same start once funded, then tracks the top-up resolution and pushes', async () => {
      await openFunding();
      await userEvent.click(screen.getByRole('button', { name: 'funded' }));

      await waitFor(() => expect(mockPush).toHaveBeenCalled());
      expect(mockStart).toHaveBeenCalledTimes(2);
      expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED, {
        via: 'top_up',
      });
    });

    it('tracks one commit for the whole attempt: the funded retry tracks no second CONFIRMED', async () => {
      await openFunding();
      await userEvent.click(screen.getByRole('button', { name: 'funded' }));
      await waitFor(() => expect(mockPush).toHaveBeenCalled());

      const confirmed = vi
        .mocked(track)
        .mock.calls.filter(([event]) => event === CALL_NOW_EVENTS.CONFIRMED);
      expect(confirmed).toHaveLength(1);
      expect(mockStart).toHaveBeenLastCalledWith({
        engagementId: ENGAGEMENT_ID,
        attemptId: ATTEMPT_ID,
      });
    });

    it('⚠ funding → Back → commit again sends no second CONFIRMED for the same attempt', async () => {
      await openFunding();
      await userEvent.click(screen.getByRole('button', { name: 'Back' }));
      mockStart.mockResolvedValueOnce(FUNDING);
      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));
      await screen.findByTestId('funding-step');

      const confirmed = vi
        .mocked(track)
        .mock.calls.filter(([event]) => event === CALL_NOW_EVENTS.CONFIRMED);
      expect(confirmed).toHaveLength(1);
      expect(mockStart).toHaveBeenCalledTimes(2);
    });

    it('does not reopen the gate when the retry is refused on funding again', async () => {
      await openFunding();
      mockStart.mockResolvedValueOnce(FUNDING);
      await userEvent.click(screen.getByRole('button', { name: 'funded' }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(CALL_NOW_COPY.fundedRetryToast));
      expect(screen.queryByTestId('funding-step')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Call now' })).toBeEnabled();
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('says the credit was added when the start fails after the top-up, and stays on the confirm', async () => {
      const { onOpenChange } = await openFunding();
      mockStart.mockResolvedValueOnce({ ok: false, code: 'venue_unavailable' });
      await userEvent.click(screen.getByRole('button', { name: 'funded' }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(CALL_NOW_COPY.fundedRetryToast));
      expect(toast.error).not.toHaveBeenCalledWith(START_FAILURE_COPY.venue_unavailable);
      expect(screen.getByRole('button', { name: 'Call now' })).toBeEnabled();
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });

    it('says the credit was added when the start throws after the top-up', async () => {
      await openFunding();
      mockStart.mockRejectedValueOnce(new Error('boom'));
      await userEvent.click(screen.getByRole('button', { name: 'funded' }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(CALL_NOW_COPY.fundedRetryToast));
      expect(screen.getByRole('button', { name: 'Call now' })).toBeEnabled();
    });

    it('keeps the specific sentence for a call that is no longer available after the top-up', async () => {
      const { onOpenChange } = await openFunding();
      mockStart.mockResolvedValueOnce({ ok: false, code: 'unavailable' });
      await userEvent.click(screen.getByRole('button', { name: 'funded' }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(START_FAILURE_COPY.unavailable));
      expect(toast.error).not.toHaveBeenCalledWith(CALL_NOW_COPY.fundedRetryToast);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('resolves the gate as abandoned once when the viewer goes Back, then Not now', async () => {
      const { onOpenChange } = await openFunding();
      await userEvent.click(screen.getByRole('button', { name: 'Back' }));
      await userEvent.click(screen.getByRole('button', { name: 'Not now' }));

      const resolved = vi
        .mocked(track)
        .mock.calls.filter(([event]) => event === CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED);
      expect(resolved).toEqual([[CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED, { via: 'abandoned' }]]);
      expect(track).toHaveBeenCalledWith(
        CALL_NOW_EVENTS.ABANDONED,
        expect.objectContaining({ step: 'confirm', via: 'not_now' })
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('does not resolve a gate that was never shown', async () => {
      renderDialog();
      await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
      expect(track).not.toHaveBeenCalledWith(
        CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED,
        expect.anything()
      );
    });

    it('Back returns to the confirm without abandoning', async () => {
      await openFunding();
      await userEvent.click(screen.getByRole('button', { name: 'Back' }));

      expect(screen.getByRole('button', { name: 'Call now' })).toBeInTheDocument();
      expect(track).not.toHaveBeenCalledWith(CALL_NOW_EVENTS.ABANDONED, expect.anything());
    });

    it('tracks booking_in_place when the retry from the confirm goes through in place', async () => {
      const candidate: ClientTerms = {
        ...CLIENT,
        inPlaceCandidate: { meetingId: IN_PLACE_ID, scheduledStartIso: '2026-11-19T10:00:00.000Z' },
      };
      await openFunding(candidate);
      await userEvent.click(screen.getByRole('button', { name: 'Back' }));
      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));

      await waitFor(() => expect(mockPush).toHaveBeenCalled());
      expect(mockStart).toHaveBeenLastCalledWith({
        engagementId: ENGAGEMENT_ID,
        attemptId: ATTEMPT_ID,
        inPlaceOfMeetingId: IN_PLACE_ID,
      });
      expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED, {
        via: 'booking_in_place',
      });
    });

    it('closing from the funding step tracks both the abandon and the abandoned resolution', async () => {
      const { onOpenChange } = await openFunding();
      await userEvent.click(screen.getByRole('button', { name: 'Close' }));

      expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.ABANDONED, {
        ...BASE_EVENT,
        lens: 'client',
        callee_presence: 'online',
        step: 'funding',
        via: 'close',
      });
      expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED, {
        via: 'abandoned',
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('⚠ Book a time from the funding step reports book-instead from funding, once', async () => {
      const { onBookTime, onOpenChange } = await openFunding();
      await userEvent.click(screen.getByRole('button', { name: 'Book a time' }));
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onBookTime).toHaveBeenCalledTimes(1);
      expect(track).not.toHaveBeenCalledWith(CALL_NOW_EVENTS.ABANDONED, expect.anything());
      const bookInstead = vi
        .mocked(track)
        .mock.calls.filter(([event]) => event === CALL_NOW_EVENTS.BOOK_INSTEAD_CLICKED);
      expect(bookInstead).toEqual([
        [CALL_NOW_EVENTS.BOOK_INSTEAD_CLICKED, { ...BASE_EVENT, lens: 'client', from: 'funding' }],
      ]);
      expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.FUNDING_GATE_RESOLVED, {
        via: 'abandoned',
      });
    });

    it('treats a funding refusal on the expert arm as a plain failure', async () => {
      mockStart.mockResolvedValue(FUNDING);
      renderDialog(EXPERT);
      await userEvent.click(screen.getByRole('button', { name: 'Call now' }));
      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(START_FAILURE_COPY.failed));
      expect(screen.queryByTestId('funding-step')).not.toBeInTheDocument();
    });
  });
});
