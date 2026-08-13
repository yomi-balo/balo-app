import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { act, render, screen, waitFor } from '@/test/utils';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import type { CaseActionResult } from '../_actions/_types/case-action-types';

/**
 * BAL-421 — the two rail mutations.
 *
 * ⚠⚠ THE ASYMMETRY IS THE SUBJECT OF THIS FILE. Only a CLIENT may close a case (BAL-417); the
 * expert may only ASK. `case-surface.test.tsx` pins which lens is OFFERED which control; this
 * file pins what each control DOES once pressed — the confirmation the close deserves and the
 * ask deliberately does not, the exact server action each calls, and the `lens` dimension each
 * reports to analytics.
 *
 * ⚠ TOAST ON EVERY OUTCOME, success AND failure (balo-ui). An agency colleague with role
 * `expert` can SEE this surface and will be REFUSED by the engagement axis server-side, so the
 * failure path is a real user journey, not a theoretical one — every mutation below is tested
 * in both directions.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';

const { mockResolveCase, mockRequestResolution, mockRefresh, mockToast } = vi.hoisted(() => ({
  mockResolveCase: vi.fn(),
  mockRequestResolution: vi.fn(),
  mockRefresh: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: mockToast }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh, push: vi.fn() }),
}));
vi.mock('../_actions/resolve-case', () => ({ resolveCaseAction: mockResolveCase }));
vi.mock('../_actions/request-resolution', () => ({
  requestResolutionAction: mockRequestResolution,
}));

import { MarkResolvedButton, RequestResolutionButton } from './case-actions';

const OK: CaseActionResult = { success: true };
const REFUSED: CaseActionResult = {
  success: false,
  error: 'You do not have access to this case.',
};

const TRIGGER = 'Mark resolved';
const CONFIRM = 'Yes, mark it resolved';
const CANCEL = 'Not yet';
const ASK = "Ask if it's resolved";

/** A promise the test decides when to settle — the only way to observe the pending render. */
function deferred(): {
  promise: Promise<CaseActionResult>;
  release: (r: CaseActionResult) => void;
} {
  let release: (r: CaseActionResult) => void = () => undefined;
  const promise = new Promise<CaseActionResult>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveCase.mockResolvedValue(OK);
  mockRequestResolution.mockResolvedValue(OK);
});

describe('MarkResolvedButton — closing is CONFIRMED, because it is terminal', () => {
  it('renders the trigger with no dialog and no mutation until it is asked for', () => {
    render(<MarkResolvedButton engagementId={ENGAGEMENT_ID} />);
    expect(screen.getByRole('button', { name: TRIGGER })).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CONFIRM })).not.toBeInTheDocument();
    expect(mockResolveCase).not.toHaveBeenCalled();
  });

  it('opens a dialog that says what a close DOES — read-only, never deleted', async () => {
    render(<MarkResolvedButton engagementId={ENGAGEMENT_ID} />);
    await userEvent.setup().click(screen.getByRole('button', { name: TRIGGER }));

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('Mark this case resolved?')).toBeInTheDocument();
    expect(screen.getByText(/The conversation becomes read-only/i)).toBeInTheDocument();
    // ⚠ OPENING IS NOT ACTING. Neither the mutation nor the analytics event may fire here.
    expect(mockResolveCase).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('calls resolveCaseAction with the engagementId, toasts, refreshes and closes', async () => {
    const user = userEvent.setup();
    render(<MarkResolvedButton engagementId={ENGAGEMENT_ID} />);

    await user.click(screen.getByRole('button', { name: TRIGGER }));
    await user.click(await screen.findByRole('button', { name: CONFIRM }));

    await waitFor(() =>
      expect(mockResolveCase).toHaveBeenCalledWith({ engagementId: ENGAGEMENT_ID })
    );
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Case marked resolved.'));
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockToast.error).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('tracks the confirmed close on the CLIENT lens, exactly once', async () => {
    const user = userEvent.setup();
    render(<MarkResolvedButton engagementId={ENGAGEMENT_ID} />);

    await user.click(screen.getByRole('button', { name: TRIGGER }));
    await user.click(await screen.findByRole('button', { name: CONFIRM }));

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CASE_ACTION_CLICKED, {
      action: 'mark_resolved',
      lens: 'client',
    });
  });

  /**
   * ⚠ THE TOAST IS THE ONLY CHANNEL A REFUSAL HAS. `AlertDialogAction` is Radix's `Action`
   * primitive, which DISMISSES the dialog on click before the action has resolved — so a
   * refusal cannot be reported inside the dialog and the error toast is load-bearing rather
   * than decorative. This asserts the whole observable outcome of a refused close.
   */
  it('toasts the server error verbatim and refreshes nothing', async () => {
    mockResolveCase.mockResolvedValue(REFUSED);
    const user = userEvent.setup();
    render(<MarkResolvedButton engagementId={ENGAGEMENT_ID} />);

    await user.click(screen.getByRole('button', { name: TRIGGER }));
    await user.click(await screen.findByRole('button', { name: CONFIRM }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(REFUSED.error));
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
    // The trigger is still there — a refused close leaves the affordance available.
    expect(screen.getByRole('button', { name: TRIGGER })).toBeInTheDocument();
  });

  it('cancelling closes the dialog without mutating or tracking anything', async () => {
    const user = userEvent.setup();
    render(<MarkResolvedButton engagementId={ENGAGEMENT_ID} />);

    await user.click(screen.getByRole('button', { name: TRIGGER }));
    await user.click(await screen.findByRole('button', { name: CANCEL }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mockResolveCase).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  /**
   * ⚠⚠ NO SECOND CONFIRM IS REACHABLE WHILE THE MUTATION IS IN FLIGHT — but NOT because the
   * confirm button disables itself. Radix's `Action` dismisses the whole dialog on the click,
   * so the confirmation UI is GONE for the entire flight. That is what this pins: one click,
   * one call, and nothing left on screen to press twice.
   *
   * (Consequence, deliberately asserted rather than assumed: the component's `pending ?
   * 'Marking resolved…'` label and the `disabled={pending}` on the two dialog buttons are
   * UNREACHABLE for the same reason. See the file report — this test does not paper over it.)
   */
  it('leaves nothing to press twice while the close is in flight', async () => {
    const { promise, release } = deferred();
    mockResolveCase.mockReturnValue(promise);
    const user = userEvent.setup();
    render(<MarkResolvedButton engagementId={ENGAGEMENT_ID} />);

    await user.click(screen.getByRole('button', { name: TRIGGER }));
    await user.click(await screen.findByRole('button', { name: CONFIRM }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: CONFIRM })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CANCEL })).not.toBeInTheDocument();
    expect(mockResolveCase).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(OK);
    });
    await waitFor(() => expect(mockToast.success).toHaveBeenCalledWith('Case marked resolved.'));
  });

  it('re-opens after a refusal, and each confirmation issues exactly one call', async () => {
    mockResolveCase.mockResolvedValue(REFUSED);
    const user = userEvent.setup();
    render(<MarkResolvedButton engagementId={ENGAGEMENT_ID} />);

    await user.click(screen.getByRole('button', { name: TRIGGER }));
    await user.click(await screen.findByRole('button', { name: CONFIRM }));
    await waitFor(() => expect(mockResolveCase).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole('button', { name: TRIGGER }));
    await user.click(await screen.findByRole('button', { name: CONFIRM }));
    await waitFor(() => expect(mockResolveCase).toHaveBeenCalledTimes(2));

    expect(track).toHaveBeenCalledTimes(2);
    expect(mockToast.error).toHaveBeenCalledTimes(2);
  });
});

describe('RequestResolutionButton — the ask changes nothing, so it is NOT confirmed', () => {
  it('mutates on the FIRST click, with no dialog in between', async () => {
    render(<RequestResolutionButton engagementId={ENGAGEMENT_ID} />);
    await userEvent.setup().click(screen.getByRole('button', { name: ASK }));

    await waitFor(() =>
      expect(mockRequestResolution).toHaveBeenCalledWith({ engagementId: ENGAGEMENT_ID })
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CONFIRM })).not.toBeInTheDocument();
  });

  it('toasts success and refreshes so the pending banner appears', async () => {
    render(<RequestResolutionButton engagementId={ENGAGEMENT_ID} />);
    await userEvent.setup().click(screen.getByRole('button', { name: ASK }));

    await waitFor(() =>
      expect(mockToast.success).toHaveBeenCalledWith('Asked if the case is resolved.')
    );
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it('tracks the ask on the EXPERT lens, exactly once', async () => {
    render(<RequestResolutionButton engagementId={ENGAGEMENT_ID} />);
    await userEvent.setup().click(screen.getByRole('button', { name: ASK }));

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(RECAP_EVENTS.CASE_ACTION_CLICKED, {
      action: 'request_resolution',
      lens: 'expert',
    });
  });

  /**
   * ⚠ THE REFUSAL IS A REAL JOURNEY, NOT A THEORETICAL ONE. Visibility (any live agency member,
   * role `expert` included) is deliberately WIDER than the act right (delivering expert ∪
   * agency owner/admin) — ADR-1046 §7. A colleague who can read this page and presses here is
   * refused server-side, so the failure path must speak.
   */
  it('toasts the engagement-axis refusal and refreshes nothing', async () => {
    mockRequestResolution.mockResolvedValue(REFUSED);
    render(<RequestResolutionButton engagementId={ENGAGEMENT_ID} />);
    await userEvent.setup().click(screen.getByRole('button', { name: ASK }));

    await waitFor(() => expect(mockToast.error).toHaveBeenCalledWith(REFUSED.error));
    expect(mockToast.success).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('states the in-flight ask and blocks a second one while it runs', async () => {
    const { promise, release } = deferred();
    mockRequestResolution.mockReturnValue(promise);
    render(<RequestResolutionButton engagementId={ENGAGEMENT_ID} />);

    await userEvent.setup().click(screen.getByRole('button', { name: ASK }));

    const asking = await screen.findByRole('button', { name: 'Asking…' });
    expect(asking).toBeDisabled();
    expect(screen.queryByRole('button', { name: ASK })).not.toBeInTheDocument();

    await act(async () => {
      release(OK);
    });
    await waitFor(() =>
      expect(mockToast.success).toHaveBeenCalledWith('Asked if the case is resolved.')
    );
    expect(mockRequestResolution).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠⚠ THE EXPERT'S CONTROL IS AN ASK, NEVER A CLOSE. Nothing in this component's tree may read
   * as marking the case resolved — the expert has no such right anywhere in the system.
   */
  it('never offers a close affordance, and calls the client action never', async () => {
    const { container } = render(<RequestResolutionButton engagementId={ENGAGEMENT_ID} />);
    expect(container.textContent ?? '').not.toMatch(/mark.*resolved/i);

    await userEvent.setup().click(screen.getByRole('button', { name: ASK }));
    await waitFor(() => expect(mockRequestResolution).toHaveBeenCalled());
    expect(mockResolveCase).not.toHaveBeenCalled();
  });
});
