import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import {
  MEMBER_JOIN_OUTAGE_ERROR,
  MEMBER_JOIN_UNAVAILABLE_ERROR,
  JOIN_UNAVAILABLE_TITLE,
  JOIN_TEMPORARILY_UNAVAILABLE_TITLE,
} from '@/lib/meetings/lobby';
import { MEMBER_JOIN_EXHAUSTED_LINE } from '@/lib/meetings/member-join-retry';
import { useMeetingRoute } from '@/lib/meetings/meeting-route-context';

/**
 * BAL-435 — the member route's client, and the first production caller of `joinAsMemberAction`.
 *
 * ⚠⚠ THE THREE THINGS THIS FILE HOLDS:
 *
 *   1. **THE RETRY IS ONE CHAIN.** "Try again" used to start a second attempt while the scheduled
 *      one was still armed, so a 503 produced DUPLICATE Daily token mints — each valid until
 *      scheduled end + 24h and non-revocable — and left an orphaned timer that could never be
 *      cleared on unmount.
 *   2. **THE ENVELOPE IS PARSED, NOT CAST.** `back-to-context.ts`'s table is total at COMPILE
 *      time only; an unexpected `context.type` was `undefined(...)`, a TypeError on the join path.
 *   3. **RULING R10 — the waiting subject.** `viewerRole` decides who is missing; without it the
 *      frame showed the delivering EXPERT the CLIENT's billing promise.
 */

const { mockJoinAsMemberAction, mockPush, mockReplace } = vi.hoisted(() => ({
  mockJoinAsMemberAction: vi.fn(),
  mockPush: vi.fn(),
  mockReplace: vi.fn(),
}));

/**
 * ⚠ BOTH `push` AND `replace` ARE MOCKED even though the component only calls `replace`. Keeping
 * `push` lets the exit tests assert it was NOT used — a silent regression from `replace` back to
 * `push` would otherwise pass, and it is the difference between Back landing on the end-of-call
 * screen and Back landing in a dead call frame.
 */
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
}));
vi.mock('@/app/join/_actions/join-as-member', () => ({
  joinAsMemberAction: mockJoinAsMemberAction,
}));
vi.mock('@/components/balo/meetings/meeting-frame', () => ({ preloadMeetingFrame: vi.fn() }));

/**
 * ⚠ THE SURFACE IS STOOD IN FOR BY A **ROUTE-CONTEXT PROBE**, deliberately. This file is about
 * what the route hands the frame — the title, the destination, the noun, the waiting subject and
 * the exit — and mounting the real Daily stack to read them would test the vendor, not the seam.
 * `meeting-frame-impl.test.tsx` covers what the frame does with them.
 */
vi.mock('@/components/balo/meetings/meeting-call-surface', () => ({
  MeetingCallSurface: (props: Record<string, unknown>) => {
    const route = useMeetingRoute();
    return (
      <div
        data-testid="surface"
        data-room-url={String(props.roomUrl)}
        data-is-owner={String(props.isOwner)}
        data-title={route.title ?? ''}
        data-back-label={route.backTo?.label ?? ''}
        data-back-href={route.backTo?.href ?? ''}
        data-context-noun={route.contextNoun}
        data-absent-party={route.waiting?.absentParty ?? ''}
        data-counterparty={route.waiting?.counterpartyFirstName ?? ''}
        data-start-label={route.waiting?.scheduledStartLabel ?? ''}
      >
        <button type="button" onClick={() => route.onExit?.('host_ended')}>
          fake host ended
        </button>
        <button type="button" onClick={() => route.onExit?.('self')}>
          fake leave
        </button>
      </div>
    );
  },
}));

import { CallClient } from './call-client';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const CONTEXT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const GRANT = {
  roomUrl: 'https://balo.daily.co/x',
  token: 'daily.jwt',
  isOwner: false,
  expiresAt: '2026-09-02T11:00:00.000Z',
  participantId: 'u0f7b1c2d3e4f4a5b8c9d0e1f2a3b4c5d',
};

function grantWith(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...GRANT, ...extra };
}

function renderClient(): HTMLElement {
  return render(<CallClient meetingId={MEETING_ID} viewerName="Dana Okoro" />).container;
}

async function surface(): Promise<HTMLElement> {
  return screen.findByTestId('surface');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  mockJoinAsMemberAction.mockResolvedValue({ success: true, grant: grantWith() });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CallClient — the grant', () => {
  it('calls the member join action exactly once on mount', async () => {
    renderClient();

    await surface();
    expect(mockJoinAsMemberAction).toHaveBeenCalledTimes(1);
    expect(mockJoinAsMemberAction).toHaveBeenCalledWith({ meetingId: MEETING_ID });
  });

  it('hands the grant straight to the surface', async () => {
    renderClient();

    expect(await surface()).toHaveAttribute('data-room-url', GRANT.roomUrl);
  });

  it('⚠ shows the shipped Connecting card while it waits', () => {
    mockJoinAsMemberAction.mockReturnValue(new Promise(() => {}));
    const container = renderClient();

    expect(container.textContent ?? '').toMatch(/connecting/i);
  });
});

describe('CallClient — ⚠ the uniform refusal vs a genuine outage', () => {
  it('a NON-outage refusal is terminal and says nothing about the meeting', async () => {
    mockJoinAsMemberAction.mockResolvedValue({
      success: false,
      error: MEMBER_JOIN_UNAVAILABLE_ERROR,
    });
    renderClient();

    expect(
      await screen.findByRole('heading', { name: JOIN_UNAVAILABLE_TITLE })
    ).toBeInTheDocument();
    // ⚠ NO retry: the api collapsed "no such meeting", "not your party" and "no capability" into
    // one literal, so there is nothing here to try again for.
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('an OUTAGE gets the retry card, which is the honest one', async () => {
    mockJoinAsMemberAction.mockResolvedValue({ success: false, error: MEMBER_JOIN_OUTAGE_ERROR });
    renderClient();

    expect(
      await screen.findByRole('heading', { name: JOIN_TEMPORARILY_UNAVAILABLE_TITLE })
    ).toBeInTheDocument();
  });

  it('⚠ a THROWN action is a transport failure, not a verdict — retry, not "unavailable"', async () => {
    mockJoinAsMemberAction.mockRejectedValue(new Error('network down'));
    renderClient();

    expect(
      await screen.findByRole('heading', { name: JOIN_TEMPORARILY_UNAVAILABLE_TITLE })
    ).toBeInTheDocument();
    expect(await screen.findByText(MEMBER_JOIN_EXHAUSTED_LINE)).toBeInTheDocument();
  });
});

describe('CallClient — ⚠⚠ the retry schedule is ONE chain', () => {
  it('retries automatically on the shipped cadence', async () => {
    mockJoinAsMemberAction.mockResolvedValue({ success: false, error: MEMBER_JOIN_OUTAGE_ERROR });
    renderClient();

    await screen.findByRole('heading', { name: JOIN_TEMPORARILY_UNAVAILABLE_TITLE });
    expect(mockJoinAsMemberAction).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockJoinAsMemberAction).toHaveBeenCalledTimes(2);
  });

  it('⚠⚠ "Try again" CANCELS the pending automatic attempt — no duplicate token mints', async () => {
    // ⚠ THE DEFECT: the retry card renders as soon as the phase flips, i.e. DURING the back-off
    // window, so clicking it started a SECOND chain while the scheduled one was still armed.
    // Every extra attempt mints another Daily token valid until scheduled end + 24h, and they
    // are not revocable.
    mockJoinAsMemberAction.mockResolvedValue({ success: false, error: MEMBER_JOIN_OUTAGE_ERROR });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderClient();

    await screen.findByRole('heading', { name: JOIN_TEMPORARILY_UNAVAILABLE_TITLE });
    await user.click(screen.getByRole('button', { name: /try again/i }));
    // The manual attempt itself is the second call…
    expect(mockJoinAsMemberAction).toHaveBeenCalledTimes(2);

    // …and the CANCELLED automatic one must never land on top of it.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockJoinAsMemberAction).toHaveBeenCalledTimes(3);
  });

  it('⚠ gives up on the SCHEDULE, never on the person', async () => {
    mockJoinAsMemberAction.mockResolvedValue({ success: false, error: MEMBER_JOIN_OUTAGE_ERROR });
    renderClient();

    await screen.findByRole('heading', { name: JOIN_TEMPORARILY_UNAVAILABLE_TITLE });
    // Eight consecutive failures is the shipped budget (`LOBBY_MAX_CONSECUTIVE_POLL_FAILURES`).
    await vi.advanceTimersByTimeAsync(8 * 15_000);

    expect(await screen.findByText(MEMBER_JOIN_EXHAUSTED_LINE)).toBeInTheDocument();
    // ⚠ THE BUTTON STAYS LIVE.
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('⚠ clears its timer on unmount', async () => {
    mockJoinAsMemberAction.mockResolvedValue({ success: false, error: MEMBER_JOIN_OUTAGE_ERROR });
    const { unmount } = render(<CallClient meetingId={MEETING_ID} viewerName={null} />);

    await screen.findByRole('heading', { name: JOIN_TEMPORARILY_UNAVAILABLE_TITLE });
    unmount();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(mockJoinAsMemberAction).toHaveBeenCalledTimes(1);
  });
});

describe('CallClient — ⚠ the context envelope becomes the chrome', () => {
  it('turns a case context into its title, its destination and its noun', async () => {
    mockJoinAsMemberAction.mockResolvedValue({
      success: true,
      grant: grantWith({
        context: { type: 'case', id: CONTEXT_ID, title: 'Salesforce flow review' },
      }),
    });
    renderClient();

    const node = await surface();
    expect(node).toHaveAttribute('data-title', 'Salesforce flow review');
    expect(node).toHaveAttribute('data-back-label', 'Back to the case');
    // ⚠ `/cases/[caseId]` is BAL-421 and does not exist yet — the label stays correct and the
    // href falls back to the nearest live ancestor, as a table entry.
    expect(node).toHaveAttribute('data-back-href', '/consultations');
    expect(node).toHaveAttribute('data-context-noun', 'case');
  });

  it('routes a project request to its own page', async () => {
    mockJoinAsMemberAction.mockResolvedValue({
      success: true,
      grant: grantWith({ context: { type: 'project_discovery', id: CONTEXT_ID, title: null } }),
    });
    renderClient();

    expect(await surface()).toHaveAttribute('data-back-href', `/projects/${CONTEXT_ID}`);
  });

  it('⚠⚠ an UNKNOWN context type degrades to the dashboard rather than crashing the join', async () => {
    // ⚠ `BACK_TO[context.contextType](id)` on an unexpected label was `undefined(...)`.
    mockJoinAsMemberAction.mockResolvedValue({
      success: true,
      grant: grantWith({ context: { type: 'admin', id: CONTEXT_ID, title: 'Ops sync' } }),
    });
    renderClient();

    const node = await surface();
    expect(node).toHaveAttribute('data-back-href', '/dashboard');
    expect(node).toHaveAttribute('data-context-noun', 'call');
    // ⚠ AND THE TITLE IS DROPPED WITH IT — a half-parsed envelope is not a source of truth.
    expect(node).toHaveAttribute('data-title', '');
  });

  it('⚠ no context at all is the guest-shaped fallback, and it still renders the call', async () => {
    renderClient();

    const node = await surface();
    expect(node).toHaveAttribute('data-back-label', 'Back to your dashboard');
    expect(node).toHaveAttribute('data-context-noun', 'call');
  });
});

describe('CallClient — ⚠⚠ ruling R10, the waiting subject', () => {
  it('a CLIENT viewer is waiting for the expert, named, from the scheduled start', async () => {
    mockJoinAsMemberAction.mockResolvedValue({
      success: true,
      grant: grantWith({
        viewerRole: 'client',
        counterpartyFirstName: 'Dana',
        scheduledStart: '2026-09-02T10:00:00.000Z',
      }),
    });
    renderClient();

    const node = await surface();
    expect(node).toHaveAttribute('data-absent-party', 'expert');
    expect(node).toHaveAttribute('data-counterparty', 'Dana');
    // ⚠ Formatted in the VIEWER's timezone, in the browser. The suite runs under `TZ=UTC`.
    expect(node.getAttribute('data-start-label') ?? '').toMatch(/10[:.]00/);
  });

  it('⚠⚠ an EXPERT viewer is waiting for the CLIENT — the branch that was unreachable', async () => {
    mockJoinAsMemberAction.mockResolvedValue({
      success: true,
      grant: grantWith({
        viewerRole: 'expert',
        counterpartyFirstName: 'Northwind Industrial',
        scheduledStart: '2026-09-02T10:00:00.000Z',
      }),
    });
    renderClient();

    expect(await surface()).toHaveAttribute('data-absent-party', 'client');
  });

  it('⚠ a missing scheduled start means NO subject — neutral copy, never a placeholder', async () => {
    mockJoinAsMemberAction.mockResolvedValue({
      success: true,
      grant: grantWith({ viewerRole: 'client', counterpartyFirstName: 'Dana' }),
    });
    renderClient();

    const node = await surface();
    expect(node).toHaveAttribute('data-absent-party', '');
    expect(node).toHaveAttribute('data-counterparty', '');
  });

  it('⚠ a malformed viewerRole degrades to neutral without costing the context', async () => {
    mockJoinAsMemberAction.mockResolvedValue({
      success: true,
      grant: grantWith({
        viewerRole: 'admin',
        counterpartyFirstName: 'Dana',
        scheduledStart: '2026-09-02T10:00:00.000Z',
        context: { type: 'case', id: CONTEXT_ID, title: 'Salesforce flow review' },
      }),
    });
    renderClient();

    const node = await surface();
    expect(node).toHaveAttribute('data-absent-party', '');
    expect(node).toHaveAttribute('data-title', 'Salesforce flow review');
  });
});

describe('CallClient — ⚠ where a member goes when the call ends', () => {
  /**
   * ⚠ BAL-389's `end/page.tsx` names this handler as its ONLY producer and forbids every other
   * entry point, so these two tests are what hold that boundary from this side. They assert
   * `replace` rather than `push` on purpose: Back must not return to a dead call frame.
   */
  it('routes a host-ended call to BAL-389, replacing the dead frame in history', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderClient();

    await surface();
    await user.click(screen.getByRole('button', { name: 'fake host ended' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(`/meetings/${MEETING_ID}/end`));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('routes to the SAME place when the person left of their own accord', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderClient();

    await surface();
    await user.click(screen.getByRole('button', { name: 'fake leave' }));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(`/meetings/${MEETING_ID}/end`));
  });
});

describe('CallClient — accessibility', () => {
  it('has no violations on the retry card', async () => {
    mockJoinAsMemberAction.mockResolvedValue({ success: false, error: MEMBER_JOIN_OUTAGE_ERROR });
    const container = renderClient();

    await screen.findByRole('heading', { name: JOIN_TEMPORARILY_UNAVAILABLE_TITLE });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations on the unavailable card', async () => {
    mockJoinAsMemberAction.mockResolvedValue({
      success: false,
      error: MEMBER_JOIN_UNAVAILABLE_ERROR,
    });
    const container = renderClient();

    await screen.findByRole('heading', { name: JOIN_UNAVAILABLE_TITLE });
    expect(await axe(container)).toHaveNoViolations();
  });
});
