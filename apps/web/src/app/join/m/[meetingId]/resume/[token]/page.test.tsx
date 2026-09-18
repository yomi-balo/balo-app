import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * ⚠⚠ THE `@balo/db` MOCK IS A TRIPWIRE, NOT A DEPENDENCY — the same rule the lobby page's own
 * test file states. This page performs ZERO database reads by design; mocking the module is
 * what lets the test ASSERT that, rather than merely relying on the absence of an import.
 */
const dbSpies = vi.hoisted(() => ({
  meetingFindById: vi.fn(),
  listByMeeting: vi.fn(),
  listLiveByMeeting: vi.fn(),
  findLiveByTokenHash: vi.fn(),
  findLivePendingLobbyByEmail: vi.fn(),
  rotatePendingLobbyToken: vi.fn(),
}));
vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: dbSpies.meetingFindById },
  meetingContextsRepository: { listByMeeting: dbSpies.listByMeeting },
  meetingGuestsRepository: {
    listLiveByMeeting: dbSpies.listLiveByMeeting,
    findLiveByTokenHash: dbSpies.findLiveByTokenHash,
    findLivePendingLobbyByEmail: dbSpies.findLivePendingLobbyByEmail,
    rotatePendingLobbyToken: dbSpies.rotatePendingLobbyToken,
  },
  usersRepository: { findNamesByIds: vi.fn() },
}));

const mockLobbyResumeClient = vi.fn<(props: Record<string, unknown>) => React.ReactElement>(() => (
  <div data-testid="lobby-resume-client" />
));
vi.mock('./lobby-resume-client', () => ({
  LobbyResumeClient: (props: Record<string, unknown>) => mockLobbyResumeClient(props),
}));

import LobbyResumePage, { metadata, dynamic, runtime } from './page';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const TOKEN = 'z'.repeat(43);

async function renderResumePage(meetingId: string, token: string): Promise<HTMLElement> {
  const element = await LobbyResumePage({ params: Promise.resolve({ meetingId, token }) });
  const { container } = render(element);
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LobbyResumePage — route configuration', () => {
  it('is nodejs runtime and force-dynamic', () => {
    expect(runtime).toBe('nodejs');
    expect(dynamic).toBe('force-dynamic');
  });

  it('is noindex with a title that names nobody', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe('Join a meeting — Balo');
  });

  it('⚠ does not override referrer — it is inherited from app/join/layout.tsx', () => {
    expect(metadata).not.toHaveProperty('referrer');
  });
});

describe('⚠⚠ LobbyResumePage — ZERO database reads', () => {
  it('performs no repository call for a valid pair', async () => {
    await renderResumePage(MEETING_ID, TOKEN);

    for (const spy of Object.values(dbSpies)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('performs no repository call for an invalid pair either', async () => {
    await renderResumePage('not-a-uuid', 'short');

    for (const spy of Object.values(dbSpies)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('LobbyResumePage — validation', () => {
  it('a malformed :meetingId renders JoinUnavailableNotice, not the client', async () => {
    await renderResumePage('not-a-uuid', TOKEN);

    expect(screen.getByText("This link isn't active")).toBeInTheDocument();
    expect(mockLobbyResumeClient).not.toHaveBeenCalled();
  });

  it('a too-short token renders JoinUnavailableNotice, not the client', async () => {
    await renderResumePage(MEETING_ID, 'short');

    expect(screen.getByText("This link isn't active")).toBeInTheDocument();
    expect(mockLobbyResumeClient).not.toHaveBeenCalled();
  });

  it('an over-long token renders JoinUnavailableNotice, not the client', async () => {
    await renderResumePage(MEETING_ID, 'x'.repeat(201));

    expect(screen.getByText("This link isn't active")).toBeInTheDocument();
    expect(mockLobbyResumeClient).not.toHaveBeenCalled();
  });

  it('a valid pair renders the client with destination === "/join/m/{uuid}"', async () => {
    await renderResumePage(MEETING_ID, TOKEN);

    expect(mockLobbyResumeClient).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingId: MEETING_ID,
        token: TOKEN,
        destination: `/join/m/${MEETING_ID}`,
      })
    );
  });
});
