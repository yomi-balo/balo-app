import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mockReplace = vi.fn();
const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}));

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

import { LobbyResumeClient } from './lobby-resume-client';
import { LOBBY_TOKEN_STORAGE_KEY, LOBBY_WAIT_STARTED_STORAGE_KEY } from '@/lib/meetings/lobby';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const OTHER_MEETING_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TOKEN = 'z'.repeat(43);
const DESTINATION = `/join/m/${MEETING_ID}`;

const TOKEN_KEY = `${LOBBY_TOKEN_STORAGE_KEY}:${MEETING_ID}`;
const WAIT_KEY = `${LOBBY_WAIT_STARTED_STORAGE_KEY}:${MEETING_ID}`;
/** The BARE, un-namespaced key — a write here would be the Correction-A regression. */
const BARE_TOKEN_KEY = LOBBY_TOKEN_STORAGE_KEY;

function renderClient(): ReturnType<typeof render> {
  return render(
    <LobbyResumeClient meetingId={MEETING_ID} token={TOKEN} destination={DESTINATION} />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.sessionStorage.clear();
});

describe('LobbyResumeClient — Correction A (namespaced storage)', () => {
  it('⚠⚠ writes the token under the NAMESPACED key, and the BARE key stays null', async () => {
    renderClient();

    await waitFor(() => {
      expect(globalThis.sessionStorage.getItem(TOKEN_KEY)).toBe(TOKEN);
    });
    const waitStart = Number.parseInt(globalThis.sessionStorage.getItem(WAIT_KEY) ?? '', 10);
    expect(Number.isFinite(waitStart)).toBe(true);
    expect(waitStart).toBeLessThanOrEqual(Date.now());
    // ⚠⚠ THE PAIRED, NEGATIVE HALF OF THE PROOF — writing the bare key is the silent-no-op
    // regression this pins.
    expect(globalThis.sessionStorage.getItem(BARE_TOKEN_KEY)).toBeNull();
  });

  it('⚠ keys are meeting-scoped — two mounts with different meeting ids write to two different sessionStorage keys', async () => {
    renderClient(); // MEETING_ID
    await waitFor(() => {
      expect(globalThis.sessionStorage.getItem(TOKEN_KEY)).toBe(TOKEN);
    });

    const otherTokenKey = `${LOBBY_TOKEN_STORAGE_KEY}:${OTHER_MEETING_ID}`;
    const otherToken = 'y'.repeat(43);
    render(
      <LobbyResumeClient
        meetingId={OTHER_MEETING_ID}
        token={otherToken}
        destination={`/join/m/${OTHER_MEETING_ID}`}
      />
    );

    await waitFor(() => {
      expect(globalThis.sessionStorage.getItem(otherTokenKey)).toBe(otherToken);
    });
    // ⚠⚠ THE PROOF — the first mount's key is untouched by the second mount, so the key is
    // genuinely derived per-meeting rather than the two mounts colliding on a shared slot.
    expect(globalThis.sessionStorage.getItem(TOKEN_KEY)).toBe(TOKEN);
    expect(otherTokenKey).not.toBe(TOKEN_KEY);
  });

  it('a STALE waiting-since from an earlier wait in this tab is OVERWRITTEN with a fresh value', async () => {
    const stale = Date.now() - 10 * 60 * 1000;
    globalThis.sessionStorage.setItem(WAIT_KEY, String(stale));

    renderClient();

    await waitFor(() => {
      const waitStart = Number.parseInt(globalThis.sessionStorage.getItem(WAIT_KEY) ?? '', 10);
      expect(waitStart).toBeGreaterThan(stale);
    });
  });
});

describe('LobbyResumeClient — navigation', () => {
  it('router.replace is called exactly once with destination; router.push is never called', async () => {
    renderClient();

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledTimes(1);
    });
    expect(mockReplace).toHaveBeenCalledWith(DESTINATION);
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('LobbyResumeClient — storage blocked', () => {
  it('a throwing sessionStorage.setItem renders the blocked card and does NOT redirect', async () => {
    const setItemSpy = vi.spyOn(globalThis.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    renderClient();

    await waitFor(() => {
      expect(screen.getByText('This browser is blocking storage')).toBeInTheDocument();
    });
    expect(mockReplace).not.toHaveBeenCalled();

    setItemSpy.mockRestore();
  });
});
