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
 *   2. **THE PAGE READS NO MEETING DATA.** Authorization is `apps/api`'s
 *      `authorizeMeetingParticipation`, reached through `joinAsMemberAction`. A read here would
 *      be a second, weaker opinion about who may join.
 */

const { mockCheckSessionDrift, mockGetCurrentUser, mockRedirect, mockLogWarn } = vi.hoisted(() => ({
  mockCheckSessionDrift: vi.fn(),
  mockGetCurrentUser: vi.fn(),
  mockRedirect: vi.fn(),
  mockLogWarn: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/lib/auth/session-sync', () => ({ checkSessionDrift: mockCheckSessionDrift }));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('@/lib/logging', () => ({
  log: { warn: mockLogWarn, error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/**
 * ⚠ THE `@balo/db` MOCK IS A TRIPWIRE, NOT A DEPENDENCY. Every member below must stay uncalled.
 */
const dbSpies = { meetingFindById: vi.fn(), listByMeeting: vi.fn() };
vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: dbSpies.meetingFindById },
  meetingContextsRepository: { listByMeeting: dbSpies.listByMeeting },
}));

vi.mock('./_components/call-client', () => ({
  CallClient: ({ meetingId, viewerName }: { meetingId: string; viewerName: string | null }) => (
    <div
      data-testid="call-client"
      data-meeting-id={meetingId}
      data-viewer-name={viewerName ?? ''}
    />
  ),
}));

import MeetingCallPage, { metadata } from './page';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';

/** ⚠ `params` is a PROMISE in Next 16 — the page must await it. */
async function renderPage(): Promise<HTMLElement> {
  const element = await MeetingCallPage({ params: Promise.resolve({ meetingId: MEETING_ID }) });
  return render(element).container;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckSessionDrift.mockResolvedValue({ action: 'none' });
  mockGetCurrentUser.mockResolvedValue({ firstName: 'Dana', lastName: 'Okoro' });
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

describe('MeetingCallPage — ⚠⚠ it reads NO meeting data', () => {
  it('touches no repository at all', async () => {
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
