import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/app/join/_actions/claim-lobby-place', () => ({
  claimLobbyPlaceAction: vi.fn(),
}));
vi.mock('@/app/join/_actions/poll-guest-admission', () => ({
  pollGuestAdmissionAction: vi.fn(),
}));

/**
 * ⚠⚠ THE `@balo/db` MOCK IS A TRIPWIRE, NOT A DEPENDENCY. This page performs ZERO database
 * reads by design (Decision 9), so every member below must stay uncalled. Mocking the module
 * is what lets the test ASSERT that, rather than merely relying on the absence of an import.
 */
const dbSpies = {
  meetingFindById: vi.fn(),
  listByMeeting: vi.fn(),
  listLiveByMeeting: vi.fn(),
  findLiveByTokenHash: vi.fn(),
};
vi.mock('@balo/db', () => ({
  meetingsRepository: { findById: dbSpies.meetingFindById },
  meetingContextsRepository: { listByMeeting: dbSpies.listByMeeting },
  meetingGuestsRepository: {
    listLiveByMeeting: dbSpies.listLiveByMeeting,
    findLiveByTokenHash: dbSpies.findLiveByTokenHash,
  },
  usersRepository: { findNamesByIds: vi.fn() },
}));

import LobbyPage, { metadata, dynamic, runtime } from './page';

const MEETING_ID = '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const OTHER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** ⚠ `params` is a PROMISE in Next 16 — the page must await it. */
async function renderLobbyPage(meetingId: string): Promise<HTMLElement> {
  const element = await LobbyPage({ params: Promise.resolve({ meetingId }) });
  const { container } = render(element);
  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.sessionStorage.clear();
});

describe('LobbyPage — route configuration', () => {
  it('is nodejs runtime and force-dynamic', () => {
    expect(runtime).toBe('nodejs');
    expect(dynamic).toBe('force-dynamic');
  });

  it('⚠ is noindex with a title that names nobody', () => {
    // The URL carries a meeting id; an indexed page would publish a meeting's existence to
    // anyone who searched, and a titled one would name the parties in a share preview.
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe('Join a meeting — Balo');
  });
});

describe('⚠⚠ LobbyPage — ZERO database reads (Decision 9)', () => {
  it('renders without touching ANY repository', async () => {
    await renderLobbyPage(MEETING_ID);

    // This is the acceptance criterion of the file. Rendering "Design review with CloudPeak"
    // to an anonymous holder of a GUESSED uuid is a disclosure; rendering "no such meeting"
    // is an existence oracle. Knowing nothing avoids both.
    for (const spy of Object.values(dbSpies)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('awaits `params` — a Next 16 Promise, not a plain object', async () => {
    // A synchronous `params` interface silently yields `undefined` for every key with no
    // error at all, so the id would never reach the client component.
    const container = await renderLobbyPage(MEETING_ID);

    expect(container.textContent ?? '').not.toContain('undefined');
    expect(screen.getByRole('button', { name: /ask to join/i })).toBeInTheDocument();
  });
});

describe('⚠⚠ LobbyPage — one identical card for every meeting id', () => {
  it('renders BYTE-IDENTICAL markup for two different ids', async () => {
    // A real meeting, a cancelled one, an ended one, a soft-deleted one and one that never
    // existed are all indistinguishable here — because the page reads nothing, they are
    // literally the same render.
    const first = await renderLobbyPage(MEETING_ID);
    const firstMarkup = first.innerHTML;
    first.remove();

    const second = await renderLobbyPage(OTHER_ID);

    expect(second.innerHTML).toBe(firstMarkup);
  });

  it('never renders the meeting id', async () => {
    const container = await renderLobbyPage(MEETING_ID);

    expect(container.textContent ?? '').not.toContain(MEETING_ID);
  });
});

/**
 * ── ⚠⚠ A MALFORMED ID IS REFUSED AT RENDER, NOT AFTER THE VISITOR TYPES THEIR DETAILS ─────
 *
 * `/join/m/not-a-uuid` used to render the full form. Every submit then failed the action's
 * `z.string().uuid()` and returned `kind: 'invalid_input'`, whose copy is "Please enter your
 * name and a valid email address." — so the page blamed the visitor, forever, for a malformed
 * URL they were sent, with nothing they could change.
 */
describe('⚠ LobbyPage — a malformed meeting id', () => {
  const MALFORMED = ['not-a-uuid', '', '0f7b1c2d-3e4f-4a5b-8c9d', '../../etc/passwd', '12345'];

  it.each(MALFORMED)('renders the unavailable card, not the form, for `%s`', async (bad) => {
    await renderLobbyPage(bad);

    expect(screen.queryByRole('button', { name: /ask to join/i })).not.toBeInTheDocument();
    expect(screen.getByText("This link isn't active")).toBeInTheDocument();
  });

  it('⚠ STILL reads nothing — the check is on the string, never on a lookup', async () => {
    // This is what keeps the zero-reads acceptance criterion intact: the only fact asserted is
    // that a string the visitor can already see is not shaped like a uuid.
    await renderLobbyPage('not-a-uuid');

    for (const spy of Object.values(dbSpies)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('⚠ never echoes the malformed id back — it is caller-controlled markup otherwise', async () => {
    const container = await renderLobbyPage('<script>alert(1)</script>');

    expect(container.textContent ?? '').not.toContain('alert(1)');
    expect(container.querySelector('script')).toBeNull();
  });

  it('a WELL-FORMED id still renders the form — the guard is narrow', async () => {
    // Non-vacuity: the assertions above must not be passing because the page refuses
    // everything. A real, cancelled, ended and never-existed meeting all still land here.
    await renderLobbyPage(MEETING_ID);

    expect(screen.getByRole('button', { name: /ask to join/i })).toBeInTheDocument();
  });
});
