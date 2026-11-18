import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { track, CALL_NOW_EVENTS } from '@/lib/analytics';
import type { BookingFundingView } from '@/lib/booking/actions/booking-funding-types';
import { refusedView } from '@/components/booking/funding/funding-fixtures';
import { callNowFundingRequest } from '@/lib/call-now/call-now-funding';
import { CallNowFundingStep } from './call-now-funding-step';

const { mockPush, mockUseFunding, mockSwitch, mockToastError, mockCaptureException } = vi.hoisted(
  () => ({
    mockPush: vi.fn(),
    mockUseFunding: vi.fn(),
    mockSwitch: vi.fn(),
    mockToastError: vi.fn(),
    mockCaptureException: vi.fn(),
  })
);

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));
vi.mock('sonner', () => ({ toast: { error: mockToastError, success: vi.fn() } }));
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));
vi.mock('@/lib/auth/actions/switch-workspace', () => ({
  switchWorkspaceAction: (...args: unknown[]) => mockSwitch(...args),
}));
vi.mock('@/components/booking/funding/use-booking-funding', () => ({
  useBookingFunding: (...args: unknown[]) => mockUseFunding(...args),
}));
vi.mock('@/components/booking/funding/booking-funding-block', () => ({
  BookingFundingBlock: ({ onFunded }: { onFunded: (via: unknown) => Promise<boolean> }) => (
    <button type="button" onClick={() => void onFunded({ method: 'topup' })}>
      pay inline
    </button>
  ),
}));

const REQUEST = callNowFundingRequest({
  expertProfileId: 'ep-1',
  engagementId: 'eng-1',
  nowMs: Date.UTC(2026, 10, 19, 4, 0, 0),
});

function withView(view: BookingFundingView | null, status = 'ready'): void {
  mockUseFunding.mockReturnValue({ status, view, refresh: vi.fn() });
}

function renderStep(overrides: Partial<React.ComponentProps<typeof CallNowFundingStep>> = {}) {
  const props = {
    request: REQUEST,
    callerLens: 'client' as const,
    onFunded: vi.fn().mockResolvedValue(true),
    onBack: vi.fn(),
    onBookInstead: vi.fn(),
    onBusyChange: vi.fn(),
    ...overrides,
  };
  render(<CallNowFundingStep {...props} />);
  return props;
}

/** A manager on the panel arm: the top-up cannot run from here. */
const PANEL_VIEW = refusedView({ suggestedTopUpMinor: 5_000_000 });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CallNowFundingStep', () => {
  it('shows a skeleton while the pre-flight is reading', () => {
    withView(null, 'loading');
    renderStep();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });

  it.each([
    ['an error', null, 'error'],
    ['an unavailable answer', { kind: 'unavailable' } as const, 'ready'],
  ])('says credit could not be checked on %s, with a way back', async (_label, view, status) => {
    withView(view, status);
    const { onBack } = renderStep();

    expect(
      screen.getByText('We couldn’t check your credit just now. Try again in a moment.')
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('continues once when the pre-flight finds credit already there', async () => {
    withView({ kind: 'clear' });
    const { onFunded } = renderStep();

    await waitFor(() => expect(onFunded).toHaveBeenCalledTimes(1));
  });

  it('does not call onFunded a second time on a re-render of a clear view', async () => {
    withView({ kind: 'clear' });
    const props = {
      request: REQUEST,
      callerLens: 'client' as const,
      onFunded: vi.fn().mockResolvedValue(true),
      onBack: vi.fn(),
      onBookInstead: null,
      onBusyChange: vi.fn(),
    };
    const { rerender } = render(<CallNowFundingStep {...props} />);
    rerender(<CallNowFundingStep {...props} />);

    await waitFor(() => expect(props.onFunded).toHaveBeenCalledTimes(1));
  });

  it('reports a failure of the automatic continue to Sentry', async () => {
    withView({ kind: 'clear' });
    renderStep({ onFunded: vi.fn().mockRejectedValue(new Error('boom')) });

    await waitFor(() => expect(mockCaptureException).toHaveBeenCalledTimes(1));
  });

  it('renders the shipped funding block inline for a manager who can top up here', async () => {
    withView(refusedView());
    const { onFunded } = renderStep();

    await userEvent.click(screen.getByRole('button', { name: 'pay inline' }));
    expect(onFunded).toHaveBeenCalledTimes(1);
  });

  it('emits the gate-shown event once, with the lens and the arm’s reason', () => {
    withView(refusedView({ arm: 'reserved' }));
    const props = {
      request: REQUEST,
      callerLens: 'expert' as const,
      onFunded: vi.fn(),
      onBack: vi.fn(),
      onBookInstead: null,
      onBusyChange: vi.fn(),
    };
    const { rerender } = render(<CallNowFundingStep {...props} />);
    rerender(<CallNowFundingStep {...props} />);

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.FUNDING_GATE_SHOWN, {
      caller_lens: 'expert',
      reason: 'reserved_by_upcoming',
    });
  });

  it.each([
    ['setup', 'insufficient'],
    ['hold', 'account_on_hold'],
  ] as const)('reports the %s arm as %s', (arm, reason) => {
    withView(refusedView({ arm }));
    renderStep();

    expect(track).toHaveBeenCalledWith(CALL_NOW_EVENTS.FUNDING_GATE_SHOWN, {
      caller_lens: 'client',
      reason,
    });
  });

  it('sends a manager on the panel arm to the top-up page', async () => {
    withView(PANEL_VIEW);
    renderStep();

    expect(screen.getByText('Add credit to start this call.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Add credit' }));
    expect(mockPush).toHaveBeenCalledWith('/billing/top-up');
    expect(mockSwitch).not.toHaveBeenCalled();
  });

  it('switches to the refusing company first when it is not the active workspace', async () => {
    withView(
      refusedView({
        suggestedTopUpMinor: 5_000_000,
        company: { id: 'company-2', name: 'Contoso', isActive: false },
      })
    );
    mockSwitch.mockResolvedValue({ success: true });
    renderStep();

    await userEvent.click(screen.getByRole('button', { name: 'Add credit' }));
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/billing/top-up'));
    expect(mockSwitch).toHaveBeenCalledTimes(1);
  });

  it('stays on the panel and says so when the workspace switch fails', async () => {
    withView(
      refusedView({
        suggestedTopUpMinor: 5_000_000,
        company: { id: 'company-2', name: 'Contoso', isActive: false },
      })
    );
    mockSwitch.mockResolvedValue({ success: false });
    renderStep();

    await userEvent.click(screen.getByRole('button', { name: 'Add credit' }));
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('reports a thrown workspace switch to Sentry and stays put', async () => {
    withView(
      refusedView({
        suggestedTopUpMinor: 5_000_000,
        company: { id: 'company-2', name: 'Contoso', isActive: false },
      })
    );
    mockSwitch.mockRejectedValue(new Error('network'));
    renderStep();

    await userEvent.click(screen.getByRole('button', { name: 'Add credit' }));
    await waitFor(() => expect(mockCaptureException).toHaveBeenCalledTimes(1));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('gives a member a call-specific panel, never the booking "save for later"', async () => {
    withView(refusedView({ canManageBilling: false, suggestedTopUpMinor: null, wallet: null }));
    const { onBookInstead, onBack } = renderStep();

    expect(screen.getByText('A billing admin needs to add credit')).toBeInTheDocument();
    expect(
      screen.getByText(/Ask a billing admin at Northwind to add it, or book a time instead\./)
    ).toBeInTheDocument();
    expect(screen.queryByText(/save and finish later/i)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Book a time' }));
    expect(onBookInstead).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('omits "Book a time" when there is nowhere to book', () => {
    withView(refusedView({ canManageBilling: false, suggestedTopUpMinor: null, wallet: null }));
    renderStep({ onBookInstead: null });

    expect(screen.queryByRole('button', { name: 'Book a time' })).toBeNull();
  });

  it('falls back to a generic company name on the member panel', () => {
    withView(
      refusedView({
        canManageBilling: false,
        suggestedTopUpMinor: null,
        wallet: null,
        company: { id: 'company-1', name: null, isActive: true },
      })
    );
    renderStep();

    expect(screen.getByText(/Ask a billing admin at your company/)).toBeInTheDocument();
  });

  it('never shows a Cancel on any arm', () => {
    for (const view of [PANEL_VIEW, refusedView({ canManageBilling: false, wallet: null })]) {
      withView(view);
      const { unmount } = render(
        <CallNowFundingStep
          request={REQUEST}
          callerLens="client"
          onFunded={vi.fn()}
          onBack={vi.fn()}
          onBookInstead={vi.fn()}
          onBusyChange={vi.fn()}
        />
      );
      expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
      unmount();
    }
  });
});
