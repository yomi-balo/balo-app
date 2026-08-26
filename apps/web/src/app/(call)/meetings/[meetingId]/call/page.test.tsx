import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * BAL-435 — the member call route's RSC.
 *
 * ⚠⚠ THE TWO THINGS THIS FILE EXISTS TO PIN:
 *
 *   1. **THE SESSION-DRIFT GATE, WITH A `returnTo` THAT POINTS BACK AT THE CALL.** The gate lived
 *      in `(call)/layout.tsx` and read `headers().get('x-invoke-path')` — a header that DOES NOT
 *      EXIST IN NEXT 16 — so a drifted member was silently sent to `/dashboard` instead of into
 *      the paid call they were entering. A layout cannot see a child segment's params; the page
 *      can, so the gate lives here.
 *   2. **THE PAGE MAKES NO AUTHORIZATION DECISION ABOUT JOINING.** Who may join is
 *      `apps/api`'s `authorizeMeetingParticipation`, reached through `joinAsMemberAction`. A
 *      read here would be a second, weaker opinion about that question.
 *
 * ⚠⚠ BAL-437 CHANGED (2) IN ONE SPECIFIC WAY, AND IT IS A DECISION RATHER THAN DRIFT. The page
 * now resolves **the CHAT SLOT** server-side (`resolveMeetingChatAccess`) so the Chat control is
 * absent-or-present from FIRST PAINT rather than after a client round trip — BAL-435's slot rule
 * ("an unregistered slot renders NOTHING, never a disabled control") is only expressible if the
 * answer is known before paint, and a button that appears then vanishes is worse than one that
 * was never there. That resolution decides a PANEL, never the join, and it can never fail the
 * page: a throw degrades to `hasChat: false` and logs the reason.
 */

const {
  mockCheckSessionDrift,
  mockGetCurrentUser,
  mockRedirect,
  mockLogWarn,
  mockResolveChatAccess,
  mockIsRealtimeConfigured,
  mockFindIdByMeetingId,
  mockGetSessionDrawdownState,
  mockAuthorizeMeetingParticipation,
  dbSpies,
} = vi.hoisted(() => ({
  mockCheckSessionDrift: vi.fn(),
  mockGetCurrentUser: vi.fn(),
  mockRedirect: vi.fn(),
  mockLogWarn: vi.fn(),
  mockResolveChatAccess: vi.fn(),
  mockIsRealtimeConfigured: vi.fn(),
  /** BAL-403 — the Balance slot's ONE repository read. */
  mockFindIdByMeetingId: vi.fn(),
  /** BAL-403 fix round 1 (C1) — the SAME membership gate the panel body reads through. */
  mockGetSessionDrawdownState: vi.fn(),
  /** BAL-466 (D3, D8) — the SAME composed gate (`resolveInCallDrawdown`) the polled
   * action runs; this RSC test proves the slot cannot disagree with it. */
  mockAuthorizeMeetingParticipation: vi.fn(),
  /**
   * ⚠ A TRIPWIRE, NOT A DEPENDENCY. The page must reach no repository DIRECTLY — the chat
   * anchor's own reads happen behind `resolveMeetingChatAccess`, which is mocked, and are
   * covered by `meeting-chat-anchor.test.ts`.
   */
  dbSpies: { meetingFindById: vi.fn(), listByMeeting: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/auth/session-sync', () => ({ checkSessionDrift: mockCheckSessionDrift }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('@/lib/credit/actions/get-drawdown-state', () => ({
  getSessionDrawdownState: mockGetSessionDrawdownState,
}));
vi.mock('@/lib/authz/meeting-participation', () => ({
  authorizeMeetingParticipation: mockAuthorizeMeetingParticipation,
}));
vi.mock('@/lib/logging', () => ({
  log: { warn: mockLogWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/meetings/meeting-chat-anchor', () => ({
  resolveMeetingChatAccess: mockResolveChatAccess,
}));
vi.mock('@/lib/realtime/ably-server', () => ({
  isRealtimeConfigured: mockIsRealtimeConfigured,
}));

vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: dbSpies.meetingFindById },
  meetingContextsRepository: { listByMeeting: dbSpies.listByMeeting },
  creditSessionsRepository: { findIdByMeetingId: mockFindIdByMeetingId },
}));

vi.mock('./_components/call-client', () => ({
  CallClient: ({
    meetingId,
    viewerName,
    hasChat,
    isRealtimeEnabled,
    chatChannelName,
    hasBalance,
  }: {
    meetingId: string;
    viewerName: string | null;
    hasChat: boolean;
    isRealtimeEnabled: boolean;
    chatChannelName: string | null;
    hasBalance: boolean;
  }) => (
    <div
      data-testid="call-client"
      data-meeting-id={meetingId}
      data-viewer-name={viewerName ?? ''}
      data-has-chat={String(hasChat)}
      data-realtime={String(isRealtimeEnabled)}
      data-chat-channel={chatChannelName ?? ''}
      data-has-balance={String(hasBalance)}
    />
  ),
}));

import MeetingCallPage, { metadata } from './page';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const USER_ID = '11111111-2222-4333-8444-555555555555';
const CONVERSATION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** ⚠ `params` is a PROMISE in Next 16 — the page must await it. */
async function renderPage(): Promise<HTMLElement> {
  const element = await MeetingCallPage({ params: Promise.resolve({ meetingId: MEETING_ID }) });
  return render(element).container;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckSessionDrift.mockResolvedValue({ action: 'none' });
  mockGetCurrentUser.mockResolvedValue({ id: USER_ID, firstName: 'Dana', lastName: 'Okoro' });
  mockResolveChatAccess.mockResolvedValue({
    ok: true,
    side: 'client',
    meetingId: MEETING_ID,
    anchor: { conversationId: CONVERSATION_ID, subject: {}, writable: true },
  });
  mockIsRealtimeConfigured.mockReturnValue(true);
  // ⚠ BAL-403 — `undefined` (no row) IS THE FIXTURE DEFAULT here, so every existing test in this
  // file that does not care about Balance still exercises the inert path. (BAL-466's join seam
  // DOES open a credit session for an admitted case client in production — this default is a
  // test fixture choice, not a claim that nothing does.)
  mockFindIdByMeetingId.mockResolvedValue(undefined);
  // ⚠ BAL-403 fix round 1 (C1) — `null` by default (not a live member), so a test that sets a
  // row on `mockFindIdByMeetingId` without opting in stays denied rather than accidentally
  // passing the gate.
  mockGetSessionDrawdownState.mockResolvedValue(null);
  // ⚠ BAL-466 (D3, D8) — the participation gate defaults to PASS, so existing tests that only
  // opt into `mockFindIdByMeetingId` / `mockGetSessionDrawdownState` still exercise exactly what
  // they did before this gate joined the composition.
  mockAuthorizeMeetingParticipation.mockResolvedValue({
    ok: true,
    side: 'client',
    companyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    expertProfileId: '88888888-8888-4888-8888-888888888888',
  });
});

describe('MeetingCallPage — route configuration', () => {
  it('⚠ is noindex — a live call must never be indexed, and its URL carries a meeting id', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

describe('MeetingCallPage — ⚠⚠ the session-drift gate', () => {
  it('redirects a DRIFTED session back into THIS call, not to the dashboard', async () => {
    mockCheckSessionDrift.mockResolvedValue({ action: 'sync-needed' });

    await renderPage();

    // ⚠ HOISTED, not inlined: a nested template literal trips SonarCloud's gate.
    const returnTo = `/meetings/${MEETING_ID}/call`;
    expect(mockRedirect).toHaveBeenCalledWith(
      `/api/auth/session-sync?returnTo=${encodeURIComponent(returnTo)}`
    );
  });

  it('⚠ does not redirect when the session is current', async () => {
    await renderPage();

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(screen.getByTestId('call-client')).toBeInTheDocument();
  });

  it('⚠ runs the gate BEFORE anything else — a stale Bearer 401s the member join', async () => {
    mockCheckSessionDrift.mockResolvedValue({ action: 'sync-needed' });

    await renderPage();

    // `postMemberJoin` forwards `session.accessToken`; a drifted session shows a valid
    // participant "This meeting isn't available to join" at the worst possible moment.
    expect(mockCheckSessionDrift).toHaveBeenCalledTimes(1);
  });
});

describe('MeetingCallPage — the viewer name', () => {
  it('passes the session name through for PreJoin identity line', async () => {
    const container = await renderPage();

    expect(container.querySelector('[data-testid="call-client"]')).toHaveAttribute(
      'data-viewer-name',
      'Dana Okoro'
    );
  });

  it('⚠ a nameless user yields null, never a guess and never their email', async () => {
    mockGetCurrentUser.mockResolvedValue({ firstName: null, lastName: null });

    const container = await renderPage();

    expect(container.querySelector('[data-testid="call-client"]')).toHaveAttribute(
      'data-viewer-name',
      ''
    );
  });

  it('⚠⚠ a session failure degrades the NAME but LOGS the reason and still renders the call', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('session store unavailable'));

    const container = await renderPage();

    expect(container.querySelector('[data-testid="call-client"]')).toBeInTheDocument();
    // CLAUDE.md: `log` in every catch that HANDLES rather than re-throws. Discarding the reason
    // is how a systematic session failure stays invisible.
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [, fields] = mockLogWarn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ meetingId: MEETING_ID });
    expect((fields as { stack?: string }).stack).toBeDefined();
  });
});

describe('MeetingCallPage — ⚠⚠ it decides no JOIN question', () => {
  it('touches no repository DIRECTLY — the join verdict is `apps/api`’s', async () => {
    await renderPage();

    expect(dbSpies.meetingFindById).not.toHaveBeenCalled();
    expect(dbSpies.listByMeeting).not.toHaveBeenCalled();
  });

  it('hands the meeting id straight to the client, unvalidated and undecided', async () => {
    const container = await renderPage();

    expect(container.querySelector('[data-testid="call-client"]')).toHaveAttribute(
      'data-meeting-id',
      MEETING_ID
    );
  });
});

describe('MeetingCallPage — BAL-437, ⚠⚠ the CHAT SLOT is resolved server-side', () => {
  it('registers chat and hands down the CONVERSATION channel when an anchor resolves', async () => {
    const container = await renderPage();
    const client = container.querySelector('[data-testid="call-client"]');

    expect(mockResolveChatAccess).toHaveBeenCalledWith({ meetingId: MEETING_ID, userId: USER_ID });
    expect(client).toHaveAttribute('data-has-chat', 'true');
    expect(client).toHaveAttribute('data-chat-channel', `conversation:${CONVERSATION_ID}`);
  });

  it('⚠⚠ NO ANCHOR ⇒ the slot is ABSENT — `hasChat` false and NO channel', async () => {
    // The four shapes that answer this — `project_discovery`, `admin`, ambiguous, and an
    // unprovisioned thread — are indistinguishable here on purpose.
    mockResolveChatAccess.mockResolvedValue({
      ok: true,
      side: 'client',
      meetingId: MEETING_ID,
      anchor: null,
    });

    const container = await renderPage();
    const client = container.querySelector('[data-testid="call-client"]');

    expect(client).toHaveAttribute('data-has-chat', 'false');
    expect(client).toHaveAttribute('data-chat-channel', '');
  });

  it('⚠ a DENIED gate is the same absence — never an error page', async () => {
    mockResolveChatAccess.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const container = await renderPage();

    expect(container.querySelector('[data-testid="call-client"]')).toHaveAttribute(
      'data-has-chat',
      'false'
    );
  });

  it('⚠⚠ a THROWN gate degrades to no-chat, LOGS the reason, and still renders the call', async () => {
    mockResolveChatAccess.mockRejectedValue(new Error('db unavailable'));

    const container = await renderPage();
    const client = container.querySelector('[data-testid="call-client"]');

    expect(client).toBeInTheDocument();
    expect(client).toHaveAttribute('data-has-chat', 'false');
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    const [, fields] = mockLogWarn.mock.calls[0] ?? [];
    expect(fields).toMatchObject({ meetingId: MEETING_ID });
  });

  it('⚠ NO SESSION ⇒ no gate call at all, and no chat', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const container = await renderPage();

    expect(mockResolveChatAccess).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="call-client"]')).toHaveAttribute(
      'data-has-chat',
      'false'
    );
  });
});

describe('MeetingCallPage — BAL-437, the realtime flag', () => {
  it('⚠⚠ the CLIENT LEARNS ONLY A BOOLEAN — `ABLY_API_KEY` never leaves the server', async () => {
    const container = await renderPage();

    expect(container.querySelector('[data-testid="call-client"]')).toHaveAttribute(
      'data-realtime',
      'true'
    );
  });

  it('⚠ unconfigured ⇒ false, which makes the Reactions control ABSENT downstream', async () => {
    mockIsRealtimeConfigured.mockReturnValue(false);

    const container = await renderPage();

    expect(container.querySelector('[data-testid="call-client"]')).toHaveAttribute(
      'data-realtime',
      'false'
    );
  });
});

describe('MeetingCallPage — BAL-403, the BALANCE slot resolves server-side', () => {
  it('⚠⚠ no credit session for this meeting ⇒ hasBalance: false — the EXPECTED path for a non-case / not-yet-admitted meeting', async () => {
    const container = await renderPage();

    expect(mockFindIdByMeetingId).toHaveBeenCalledWith(MEETING_ID);
    expect(container.querySelector('[data-testid="call-client"]')).toHaveAttribute(
      'data-has-balance',
      'false'
    );
  });

  it('⚠⚠ C1 — a credit session for this meeting, and the viewer is a LIVE MEMBER ⇒ hasBalance: true', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: 'sess-1' });
    mockGetSessionDrawdownState.mockResolvedValue({ key: 'healthy' });

    const container = await renderPage();

    expect(mockGetSessionDrawdownState).toHaveBeenCalledWith('sess-1', USER_ID);
    expect(container.querySelector('[data-testid="call-client"]')).toHaveAttribute(
      'data-has-balance',
      'true'
    );
  });

  it('⚠⚠ C1 — a credit session exists but the viewer is NOT a live member ⇒ hasBalance: false, never an existence leak', async () => {
    mockFindIdByMeetingId.mockResolvedValue({ id: 'sess-1' });
    mockGetSessionDrawdownState.mockResolvedValue(null);

    const container = await renderPage();

    expect(container.querySelector('[data-testid="call-client"]')).toHaveAttribute(
      'data-has-balance',
      'false'
    );
  });

  it('⚠⚠ a throwing repository degrades to hasBalance: false, LOGS the reason, and still renders', async () => {
    mockFindIdByMeetingId.mockRejectedValue(new Error('db unavailable'));

    const container = await renderPage();
    const client = container.querySelector('[data-testid="call-client"]');

    expect(client).toBeInTheDocument();
    expect(client).toHaveAttribute('data-has-balance', 'false');
    expect(mockLogWarn).toHaveBeenCalledWith(
      'Call page could not resolve the credit session',
      expect.objectContaining({ meetingId: MEETING_ID })
    );
  });

  it('⚠ NO SESSION ⇒ no repository call at all, and no balance', async () => {
    mockGetCurrentUser.mockResolvedValue(null);

    const container = await renderPage();

    expect(mockFindIdByMeetingId).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="call-client"]')).toHaveAttribute(
      'data-has-balance',
      'false'
    );
  });

  it('⚠⚠ BAL-466 (D3, D8) — a session exists but the PARTICIPATION gate denies ⇒ hasBalance: false, matching the polled action byte-for-byte, and no repo call', async () => {
    // ⚠ THE EXACT SHAPE THAT DISAGREED PRE-FIX: round 1's RSC never ran a participation check
    // at all, so this combination answered `hasBalance: true` here while
    // `get-meeting-drawdown-state.ts` answered `{ success: true, state: null }` — a rendered
    // button over an eternal skeleton. `resolveInCallDrawdown` closes the gap by construction:
    // both callers run this exact same check now, and (D8) it runs FIRST — so a denied actor
    // never reaches `findIdByMeetingId` at all.
    mockFindIdByMeetingId.mockResolvedValue({ id: 'sess-1' });
    mockGetSessionDrawdownState.mockResolvedValue({ key: 'healthy' });
    mockAuthorizeMeetingParticipation.mockResolvedValue({ ok: false, code: 'meeting_not_found' });

    const container = await renderPage();

    expect(mockAuthorizeMeetingParticipation).toHaveBeenCalledWith({
      meetingId: MEETING_ID,
      userId: USER_ID,
    });
    expect(mockFindIdByMeetingId).not.toHaveBeenCalled();
    expect(mockGetSessionDrawdownState).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="call-client"]')).toHaveAttribute(
      'data-has-balance',
      'false'
    );
  });
});
