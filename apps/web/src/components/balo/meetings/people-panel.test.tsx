import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { toast } from 'sonner';
import type { GuestForViewer } from '@balo/shared/meetings';
import { MEETING_PANEL_EVENTS, track } from '@/lib/analytics';
import type { MeetingMemberPanelRegistration } from '@/lib/meetings/meeting-panels';
import { containsEmailAddress } from '@/test/contains-email-address';
import { dailyState, resetDailyMock } from '@/test/mocks/daily';
import { PeoplePanel } from './people-panel';

/**
 * BAL-436 — the People panel.
 *
 * ── ⚠⚠ THE FOUR THINGS THIS FILE EXISTS TO HOLD ──────────────────────────────────────────
 *
 *   1. **THE QUEUE IS GATED ON `canHost` FROM THE SERVER.** Absent when false, present when
 *      true. The design prototype gates it on a VIEW; that is the comparison ADR-1029 forbids.
 *   2. **NO EMAIL ADDRESS APPEARS ANYWHERE FOR A `link` ROW** — asserted on the whole rendered
 *      text, because the point is that it cannot be rendered even by accident.
 *   3. **THE UNVERIFIED BADGE IS A BADGE**, on every `link` row and no `email` row.
 *   4. **THE FOOTER STAYS USABLE WHILE THE ROSTER READ IS IN ITS ERROR STATE** — a failed list
 *      must not remove a host's ability to invite or to copy the link.
 */

vi.mock('@daily-co/daily-react', async () => {
  const { dailyReactModuleMock } = await import('@/test/mocks/daily');
  return dailyReactModuleMock();
});

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const MEETING_PROPS = { meeting_id: '0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d' };
const JOIN_LINK = 'https://balo.test/join/m/0f7b1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';

/** ⚠ `matchMedia` — the panel shell reads it directly. `false` selects the sidebar branch. */
function stubMatchMedia(): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

function guest(overrides: Partial<GuestForViewer> & { id: string }): GuestForViewer {
  return {
    name: 'Dana Okoro',
    displayName: 'Dana Okoro',
    party: 'client',
    participationRole: 'guest',
    admission: 'pre_admitted',
    inviteChannel: 'email',
    ...overrides,
  };
}

/**
 * ⚠⚠ **THE LEAK-BAIT ADDRESS, AND WHY IT IS ON THE FIXTURE AT ALL.**
 *
 * `GuestForViewer.email` is OPTIONAL, so a `link` row with no `email` key is a perfectly valid
 * payload — and an earlier version of this fixture simply never set one. That made the whole
 * concealment sweep INERT: rendering `{guest.email}` straight into `lobby-queue-row.tsx` left
 * every test in this file green, because there was no address in scope to leak.
 *
 * The projector's `link` arm is what removes the field in production. This fixture deliberately
 * VIOLATES that — it puts the address on the wire — so the sweep asserts that the UI renders
 * nothing even when handed one. Both halves are needed: the projector is tested in
 * `packages/shared`, and this file is the second, independent line.
 *
 * ⚠ DO NOT "FIX" THIS FIXTURE TO MATCH THE PROJECTOR. A fixture that cannot leak cannot detect
 * a leak.
 */
const BAIT_EMAIL = 'taylor@somewhere.example';

/**
 * ⚠ A KNOCK. Its `party` is the lobby writer's PLACEHOLDER.
 *
 * ⚠⚠ IT CARRIES {@link BAIT_EMAIL} — see above. The production projector would have stripped
 * it; this fixture keeps it so the sweep has something to catch.
 */
const KNOCKER = guest({
  id: 'knock-1',
  name: 'Taylor Wu',
  displayName: 'Taylor Wu',
  admission: 'pending',
  inviteChannel: 'link',
  email: BAIT_EMAIL,
  emailDomain: 'somewhere.example',
});

interface PanelFakes {
  readonly panels: MeetingMemberPanelRegistration;
  readonly loadGuests: ReturnType<typeof vi.fn>;
  readonly inviteGuests: ReturnType<typeof vi.fn>;
  readonly decideAdmission: ReturnType<typeof vi.fn>;
  readonly resendLink: ReturnType<typeof vi.fn>;
  readonly removeGuest: ReturnType<typeof vi.fn>;
}

function fakes(
  options: {
    guests?: readonly GuestForViewer[];
    canHost?: boolean;
    failLoad?: boolean;
    /** BAL-476 — the viewer's own SERVER-resolved side. Defaults to the fixtures' party. */
    viewerSide?: 'client' | 'expert';
  } = {}
): PanelFakes {
  const loadGuests = vi.fn().mockResolvedValue(
    options.failLoad === true
      ? { success: false, error: "We couldn't reach the call service.", retryable: true }
      : {
          success: true,
          data: {
            guests: options.guests ?? [],
            canHost: options.canHost ?? false,
            viewerSide: options.viewerSide ?? 'client',
            participantCount: 3,
            participantCap: 10,
          },
        }
  );
  const inviteGuests = vi
    .fn()
    .mockResolvedValue({ success: true, invitedCount: 1, participantCount: 4, participantCap: 10 });
  const decideAdmission = vi.fn().mockResolvedValue({ success: true });
  const resendLink = vi.fn().mockResolvedValue({ success: true });
  const removeGuest = vi.fn().mockResolvedValue({ success: true });

  return {
    loadGuests,
    inviteGuests,
    decideAdmission,
    resendLink,
    removeGuest,
    panels: {
      audience: 'member',
      joinLinkUrl: JOIN_LINK,
      loadGuests,
      inviteGuests,
      decideAdmission,
      resendLink,
      removeGuest,
      files: {
        list: vi.fn(),
        requestUpload: vi.fn(),
        confirmUpload: vi.fn(),
        download: vi.fn(),
      },
    } as unknown as MeetingMemberPanelRegistration,
  };
}

/** ⚠ The frame's ONE §16 live region, as a spy. Reassigned per render. */
let onAnnounce = vi.fn();

function renderPanel(fake: PanelFakes): HTMLElement {
  onAnnounce = vi.fn();
  return render(
    <PeoplePanel
      panels={fake.panels}
      onClose={vi.fn()}
      onSeatsChange={vi.fn()}
      meetingProps={MEETING_PROPS}
      onAnnounce={onAnnounce}
    />
  ).container;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDailyMock();
  stubMatchMedia();
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    writable: true,
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe('PeoplePanel — the four async states', () => {
  it('LOADING: skeleton rows while the first read is in flight', () => {
    const fake = fakes();
    fake.loadGuests.mockReturnValue(new Promise(() => {}));

    renderPanel(fake);

    expect(screen.getByTestId('panel-skeleton')).toBeInTheDocument();
  });

  it('SUCCESS: renders the sections once the read resolves', async () => {
    const fake = fakes({ guests: [guest({ id: 'g1' })] });

    renderPanel(fake);

    expect(await screen.findByText('Dana Okoro')).toBeInTheDocument();
    expect(screen.getByText(/Invited · 1/)).toBeInTheDocument();
  });

  it('⚠ EMPTY IS NEVER WHOLLY EMPTY — "In the call" always has at least the viewer', async () => {
    renderPanel(fakes());

    expect(await screen.findByText(/In the call · 1/)).toBeInTheDocument();
  });

  it('ERROR: an inline card plus Retry, and the read is re-attempted on click', async () => {
    const user = userEvent.setup();
    const fake = fakes({ failLoad: true });

    renderPanel(fake);

    expect(await screen.findByTestId('panel-error')).toBeInTheDocument();
    fake.loadGuests.mockClear();
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(fake.loadGuests).toHaveBeenCalled());
  });

  it('⚠⚠ ERROR LEAVES THE FOOTER USABLE — a failed list must not remove the ability to invite', async () => {
    renderPanel(fakes({ failLoad: true }));

    await screen.findByTestId('panel-error');
    expect(screen.getByRole('button', { name: /add people/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /copy join link/i })).toBeEnabled();
  });
});

describe('PeoplePanel — ⚠⚠ the queue gates on the SERVER verdict', () => {
  it('is ABSENT when `canHost` is false, even with a knock on the payload', async () => {
    renderPanel(fakes({ guests: [KNOCKER], canHost: false }));

    await screen.findByText(/In the call/);
    expect(screen.queryByText(/Waiting to join/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /admit/i })).not.toBeInTheDocument();
  });

  it('is PRESENT when `canHost` is true, with Admit and Deny naming the person', async () => {
    renderPanel(fakes({ guests: [KNOCKER], canHost: true }));

    expect(await screen.findByText(/Waiting to join · 1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Admit Taylor Wu' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny Taylor Wu' })).toBeInTheDocument();
  });

  it('⚠ shows the "Balo hasn`t checked who they are" disclosure ABOVE the queue', async () => {
    renderPanel(fakes({ guests: [KNOCKER], canHost: true }));

    expect(await screen.findByText(/Balo hasn't checked who they are/)).toBeInTheDocument();
  });
});

describe('PeoplePanel — ⚠⚠ the UNVERIFIED treatment', () => {
  it('renders the badge for a `link` row', async () => {
    renderPanel(fakes({ guests: [KNOCKER], canHost: true }));

    expect(await screen.findByText('Unverified')).toBeInTheDocument();
  });

  it('does NOT render it for an `email` row', async () => {
    renderPanel(fakes({ guests: [guest({ id: 'g1' })] }));

    await screen.findByText('Dana Okoro');
    expect(screen.queryByText('Unverified')).not.toBeInTheDocument();
  });

  it('⚠ STAYS on an ADMITTED `link` row — admitting somebody is not verifying them', async () => {
    const admitted = guest({
      id: 'k2',
      name: 'Taylor Wu',
      displayName: 'Taylor Wu',
      admission: 'admitted',
      inviteChannel: 'link',
      admissionDecidedAt: '2026-09-01T10:00:00.000Z',
    });

    renderPanel(fakes({ guests: [admitted], canHost: true }));

    await screen.findByText(/Admitted · not yet arrived/);
    expect(screen.getByText('Unverified')).toBeInTheDocument();
  });

  /**
   * ⚠⚠ **THE TICKET'S CENTRAL OBLIGATION, SWEPT OVER ALL THREE `link` STATES.**
   *
   * Every fixture here carries {@link BAIT_EMAIL} on the wire — i.e. it is the payload the
   * projector is supposed to prevent, handed to the UI anyway. So a `{guest.email}` slipped
   * into ANY of the three row components fails here, which is what makes this a test rather
   * than a restatement of the projector's docblock.
   *
   * ⚠ ALL THREE STATES, BECAUSE THEY ARE THREE DIFFERENT COMPONENTS: `waiting` renders
   * `LobbyQueueRow`, `in_call` and `not_arrived` render `PeoplePanelRow`, and the sections
   * around them differ. A sweep over one state leaves the other two unguarded.
   */
  it.each([
    ['waiting (LobbyQueueRow)', KNOCKER, /Waiting to join/],
    [
      'not_arrived (PeoplePanelRow)',
      guest({
        id: 'stuck-9',
        name: 'Taylor Wu',
        displayName: 'Taylor Wu',
        admission: 'admitted',
        inviteChannel: 'link',
        admissionDecidedAt: '2020-01-01T00:00:00.000Z',
        email: BAIT_EMAIL,
        emailDomain: 'somewhere.example',
      }),
      /Admitted · not yet arrived/,
    ],
  ])(
    '⚠⚠ NO EMAIL ADDRESS APPEARS ANYWHERE for a `link` row — %s',
    async (_label, row, sectionPattern) => {
      const container = renderPanel(fakes({ guests: [row], canHost: true }));

      await screen.findByText(sectionPattern);
      // ⚠ SANITY-CHECK THE BAIT FIRST. If the fixture stopped carrying an address, the sweep
      // below would pass vacuously — which is exactly how this test was inert before.
      expect(containsEmailAddress(BAIT_EMAIL)).toBe(true);
      expect(containsEmailAddress(container.textContent ?? '')).toBe(false);
    }
  );

  it('⚠⚠ NO EMAIL ADDRESS APPEARS ANYWHERE for a `link` row — in_call (PeoplePanelRow)', async () => {
    const guestId = '11111111-2222-4333-8444-555555555555';
    dailyState.participantIds = ['local-session', 'guest-session'];
    dailyState.participants = {
      'local-session': { user_name: 'You', owner: false },
      'guest-session': {
        user_name: 'Taylor Wu',
        owner: false,
        user_id: `g${guestId.replaceAll('-', '')}`,
      },
    };
    const arrived = guest({
      id: guestId,
      name: 'Taylor Wu',
      displayName: 'Taylor Wu',
      admission: 'admitted',
      inviteChannel: 'link',
      admissionDecidedAt: '2020-01-01T00:00:00.000Z',
      email: BAIT_EMAIL,
      emailDomain: 'somewhere.example',
    });

    const container = renderPanel(fakes({ guests: [arrived], canHost: true }));

    await screen.findByText(/In the call · 2/);
    expect(containsEmailAddress(BAIT_EMAIL)).toBe(true);
    expect(containsEmailAddress(container.textContent ?? '')).toBe(false);
  });

  /**
   * ⚠⚠ THE BADGE MUST SURVIVE THE PERSON WALKING IN.
   *
   * `buildGuestRoster` computes `isUnverified` for the `inCall` bucket too, but the panel used
   * to render every live participant as a bare `PresentParticipantRow` and never read that
   * bucket — so the badge vanished the moment the stranger arrived, i.e. exactly when a host
   * looks at the list to work out who is in the room.
   */
  it('⚠⚠ KEEPS the badge on a `link` guest who has ARRIVED — presence is not verification', async () => {
    const guestId = '11111111-2222-4333-8444-555555555555';
    dailyState.participantIds = ['local-session', 'guest-session'];
    dailyState.participants = {
      'local-session': { user_name: 'You', owner: false },
      'guest-session': {
        user_name: 'Taylor Wu',
        owner: false,
        user_id: `g${guestId.replaceAll('-', '')}`,
      },
    };
    const arrived = guest({
      id: guestId,
      name: 'Taylor Wu',
      displayName: 'Taylor Wu',
      admission: 'admitted',
      inviteChannel: 'link',
      admissionDecidedAt: '2020-01-01T00:00:00.000Z',
    });

    renderPanel(fakes({ guests: [arrived], canHost: true }));

    expect(await screen.findByText(/In the call · 2/)).toBeInTheDocument();

    // ⚠ `findByText`, NOT `getByText` — and the reason is specific to THIS test, not a blanket
    // style rule. The heading above is driven by DAILY PARTICIPANT state, while the badge is
    // driven by the GUEST ROSTER: two independent async sources. So the heading resolving
    // proves nothing about the roster having landed, and asserting the badge synchronously
    // right after it is a race — one this test lost in CI (and only in CI, where the slower,
    // contended scheduling widens the window; it passed locally every time, including across
    // the full 621-file suite). The failure surfaced as `Unable to find an element with the
    // text: Unverified` buried under a DOM dump still showing `data-testid="panel-skeleton"`.
    //
    // The sibling test above (`STAYS on an ADMITTED link row`) keeps its synchronous
    // `getByText` deliberately: there the heading and the badge come from the SAME roster
    // render pass, so there is no second source to wait on.
    expect(await screen.findByText('Unverified')).toBeInTheDocument();

    // Checked AFTER the badge, so the roster is known to have rendered — a `queryBy`
    // absence assertion against a not-yet-rendered roster would pass for the wrong reason.
    expect(screen.queryByText(/not yet arrived/)).not.toBeInTheDocument();
  });

  it('⚠ an `email`-channel guest who has arrived carries NO badge', async () => {
    const guestId = '22222222-3333-4444-8555-666666666666';
    dailyState.participantIds = ['local-session', 'guest-session'];
    dailyState.participants = {
      'local-session': { user_name: 'You', owner: false },
      'guest-session': {
        user_name: 'Dana Okoro',
        owner: false,
        user_id: `g${guestId.replaceAll('-', '')}`,
      },
    };

    renderPanel(fakes({ guests: [guest({ id: guestId })], canHost: true }));

    await screen.findByText(/In the call · 2/);
    expect(screen.queryByText('Unverified')).not.toBeInTheDocument();
  });
});

describe('PeoplePanel — admit and deny', () => {
  it('forwards the decision and refetches on success', async () => {
    const user = userEvent.setup();
    const fake = fakes({ guests: [KNOCKER], canHost: true });

    renderPanel(fake);
    await user.click(await screen.findByRole('button', { name: 'Admit Taylor Wu' }));

    await waitFor(() => expect(fake.decideAdmission).toHaveBeenCalledWith('knock-1', 'admit'));
    expect(toast.success).toHaveBeenCalled();
    await waitFor(() => expect(fake.loadGuests).toHaveBeenCalledTimes(2));
  });

  it('⚠⚠ A `409` RACE IS AN **INFORMATIONAL** TOAST PLUS A REFETCH, never an error toast', async () => {
    const user = userEvent.setup();
    const fake = fakes({ guests: [KNOCKER], canHost: true });
    fake.decideAdmission.mockResolvedValue({
      success: false,
      error: 'Someone else already decided this.',
      outcome: 'already_decided',
    });

    renderPanel(fake);
    await user.click(await screen.findByRole('button', { name: 'Deny Taylor Wu' }));

    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledWith('Someone else already decided this.')
    );
    expect(toast.error).not.toHaveBeenCalled();
    await waitFor(() => expect(fake.loadGuests).toHaveBeenCalledTimes(2));
  });

  it('records the outcome on the analytics event, taken from the result not from the copy', async () => {
    const user = userEvent.setup();
    const fake = fakes({ guests: [KNOCKER], canHost: true });

    renderPanel(fake);
    await user.click(await screen.findByRole('button', { name: 'Admit Taylor Wu' }));

    await waitFor(() =>
      expect(track).toHaveBeenCalledWith(MEETING_PANEL_EVENTS.GUEST_DECIDED, {
        ...MEETING_PROPS,
        decision: 'admit',
        outcome: 'ok',
      })
    );
  });

  it('⚠ shows a PER-ROW spinner, and never `aria-busy`', async () => {
    const user = userEvent.setup();
    const fake = fakes({ guests: [KNOCKER], canHost: true });
    fake.decideAdmission.mockReturnValue(new Promise(() => {}));

    const container = renderPanel(fake);
    await user.click(await screen.findByRole('button', { name: 'Admit Taylor Wu' }));

    expect(await screen.findByTestId('queue-row-spinner')).toBeInTheDocument();
    expect(container.querySelector('[aria-busy]')).toBeNull();
  });
});

describe('PeoplePanel — the re-send affordance', () => {
  const stranded = guest({
    id: 'stuck-1',
    name: 'Taylor Wu',
    displayName: 'Taylor Wu',
    admission: 'admitted',
    inviteChannel: 'link',
    admissionDecidedAt: '2020-01-01T00:00:00.000Z',
  });

  it('appears once the grace period has elapsed, naming the person', async () => {
    renderPanel(fakes({ guests: [stranded], canHost: true }));

    expect(
      await screen.findByRole('button', { name: 'Re-send the join link to Taylor Wu' })
    ).toBeInTheDocument();
  });

  it('⚠ is ABSENT on a freshly admitted row — the grace period has not elapsed', async () => {
    const fresh = { ...stranded, admissionDecidedAt: new Date().toISOString() };

    renderPanel(fakes({ guests: [fresh], canHost: true }));

    await screen.findByText(/Admitted · not yet arrived/);
    expect(screen.queryByRole('button', { name: /re-send/i })).not.toBeInTheDocument();
  });

  it('⚠ says plainly that it REPLACES the link they had', async () => {
    renderPanel(fakes({ guests: [stranded], canHost: true }));

    expect(await screen.findByText(/replaces the link they had/i)).toBeInTheDocument();
  });

  it('toasts and refetches on success', async () => {
    const user = userEvent.setup();
    const fake = fakes({ guests: [stranded], canHost: true });

    renderPanel(fake);
    await user.click(
      await screen.findByRole('button', { name: 'Re-send the join link to Taylor Wu' })
    );

    await waitFor(() => expect(fake.resendLink).toHaveBeenCalledWith('stuck-1'));
    // ⚠ NAMES THE PERSON — with several stranded rows, "A fresh link is on its way." does not
    // say WHOSE, which is the one thing the host needs confirmed.
    expect(toast.success).toHaveBeenCalledWith('A fresh link is on its way to Taylor Wu.');
  });
});

describe('PeoplePanel — the footer', () => {
  it('⚠⚠ "Add people" is NEVER disabled on a full room — the SERVER refuses, not the client', async () => {
    // `listGuests`' docblock names that exact regression: a client-side `count >= cap` gate
    // reintroduces the invite lockout the counter split exists to close.
    const fake = fakes();
    fake.loadGuests.mockResolvedValue({
      success: true,
      data: { guests: [], canHost: true, participantCount: 10, participantCap: 10 },
    });

    renderPanel(fake);

    expect(await screen.findByRole('button', { name: /add people/i })).toBeEnabled();
  });

  it('invites the typed address and reports the outcome', async () => {
    const user = userEvent.setup();
    const fake = fakes({ canHost: true });

    renderPanel(fake);
    await user.click(await screen.findByRole('button', { name: /add people/i }));
    await user.type(screen.getByLabelText(/email address to invite/i), 'sam@northwind.example');
    await user.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() => expect(fake.inviteGuests).toHaveBeenCalledWith(['sam@northwind.example']));
    // ⚠ NAMES THE ADDRESS. This is the host's OWN typed input echoed back — not a concealed
    // field, and the only confirmation that it went where they meant.
    expect(toast.success).toHaveBeenCalledWith('Invite sent to sam@northwind.example.');
  });

  it('⚠ an "already on the list" refusal carries an ACTIONABLE next step', async () => {
    // ⚠⚠ THE DEAD END THIS CLOSES: "They're already on the list." is what a host is told when
    // somebody says "I never got the invite" — and the panel's re-send affordance is
    // server-restricted to `link`+`admitted` rows, so it can never appear beside an email
    // invitee. Without a next step the host is simply stuck.
    const user = userEvent.setup();
    const fake = fakes({ canHost: true });
    fake.inviteGuests.mockResolvedValue({
      success: false,
      error: "They're already on the list.",
      outcome: 'already_invited',
    });

    renderPanel(fake);
    await user.click(await screen.findByRole('button', { name: /add people/i }));
    await user.type(screen.getByLabelText(/email address to invite/i), 'sam@northwind.example');
    await user.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('forward them the join link')
      )
    );
  });

  it('surfaces a cap refusal as the server`s sentence, not as a disabled button', async () => {
    const user = userEvent.setup();
    const fake = fakes({ canHost: true });
    fake.inviteGuests.mockResolvedValue({
      success: false,
      error: 'This call is full — 10 people is the limit.',
      outcome: 'cap_reached',
    });

    renderPanel(fake);
    await user.click(await screen.findByRole('button', { name: /add people/i }));
    await user.type(screen.getByLabelText(/email address to invite/i), 'sam@northwind.example');
    await user.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This call is full — 10 people is the limit.')
    );
  });

  it('⚠⚠ COPY JOIN LINK writes a URL with NO TOKEN SUBSTRING', async () => {
    const user = userEvent.setup();
    // ⚠ INSTALLED **AFTER** `userEvent.setup()`, which replaces `navigator.clipboard` with its
    // own stub. Installing it in `beforeEach` alone would silently assert on the harness.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      writable: true,
      configurable: true,
      value: { writeText },
    });

    renderPanel(fakes());
    await user.click(await screen.findByRole('button', { name: /copy join link/i }));

    const written = writeText.mock.calls[0]?.[0] ?? '';
    expect(written).toBe(JOIN_LINK);
    // A 43-char base64url run is the mint's shape; a 64-char hex run is the stored form.
    expect(written).not.toMatch(/[A-Za-z0-9_-]{43}/);
    expect(written).not.toMatch(/\b[0-9a-f]{64}\b/);
  });

  /**
   * ⚠⚠ THE SENTENCE THIS REPLACED SENT HOSTS TO THE ADDRESS BAR — "You can select it from the
   * address bar instead." The People panel only mounts on the MEMBER call route
   * (`/meetings/{meetingId}/call`), which is never the join link. A guest handed that URL is
   * 307'd to `/login`; a signed-in non-participant is refused by `authorizeMeetingParticipation`.
   * So the fallback sent hosts to the one URL that cannot work, exactly when copy had failed and
   * they had no other way to get the right one.
   *
   * ⚠ `clipboard: undefined` IS THE BRANCH UNDER TEST — an insecure context, or an embedded
   * webview with no Clipboard API at all. A rejected write (the next test) is a different
   * branch with different copy, because there a retry can succeed.
   */
  it('⚠⚠ CLIPBOARD UNAVAILABLE: names the email invite, NEVER the address bar', async () => {
    const user = userEvent.setup();
    // ⚠ INSTALLED **AFTER** `userEvent.setup()` — see the COPY JOIN LINK test above for why.
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      writable: true,
      configurable: true,
      value: undefined,
    });

    const container = renderPanel(fakes());
    await user.click(await screen.findByRole('button', { name: /copy join link/i }));

    const sentence =
      "We couldn't copy the link in this browser. Use Add people to invite them by email instead.";
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(sentence));
    // ⚠ THE SAME SENTENCE IN BOTH CHANNELS — §16's one live region gets what the toast got.
    expect(onAnnounce).toHaveBeenCalledWith(sentence);
    // ⚠⚠ THE REGRESSION ITSELF, asserted independently of the literal above: a future copy edit
    // updates that literal, and must still never bring the address bar back.
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringMatching(/address bar/i));
    // ⚠ NOTHING WAS COPIED, so nothing may say it was.
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Copy join link' })).toBeInTheDocument();
    // ⚠⚠ AND THE URL IS NOT REVEALED INSTEAD — `joinLinkUrl` stays out of the DOM on the
    // failure path exactly as it does on the success path.
    expect(container.innerHTML).not.toContain('/join/m/');
  });

  it('⚠ a REJECTED write is transient — it says try again, and never claims a copy', async () => {
    const user = userEvent.setup();
    // ⚠ A rejection is what a lost focus or a dismissed permission prompt produces: the API
    // exists, so — unlike the unavailable case above — a retry CAN succeed.
    const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      writable: true,
      configurable: true,
      value: { writeText },
    });

    renderPanel(fakes());
    await user.click(await screen.findByRole('button', { name: /copy join link/i }));

    const sentence = "We couldn't copy the link. Try again in a moment.";
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(sentence));
    expect(writeText).toHaveBeenCalledWith(JOIN_LINK);
    expect(onAnnounce).toHaveBeenCalledWith(sentence);
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Copy join link' })).toBeInTheDocument();
  });

  it('says plainly that anyone using the link asks to be let in', async () => {
    renderPanel(fakes());

    expect(
      await screen.findByText('Anyone using this link asks to be let in.')
    ).toBeInTheDocument();
  });

  it('⚠ renders the SERVER`s seat figure, never a local tile count', async () => {
    renderPanel(fakes({ guests: [guest({ id: 'g1' })] }));

    // One Daily tile, three seats — the two are different numbers and both are shown.
    expect(await screen.findByText('3 of 10 seats taken')).toBeInTheDocument();
    expect(screen.getByText(/In the call · 1/)).toBeInTheDocument();
  });

  it('shows the email-vs-link contrast at the bottom', async () => {
    renderPanel(fakes());

    expect(
      await screen.findByText(
        'People you invite by email join straight away. Anyone using the link asks to be let in.'
      )
    ).toBeInTheDocument();
  });
});

describe('PeoplePanel — the live roster', () => {
  it('renders present participants from Daily`s own `user_name` claim, marking the viewer', async () => {
    dailyState.participantIds = ['local-session', 'remote-1'];
    dailyState.participants = {
      'local-session': { user_name: 'You', owner: false },
      'remote-1': { user_name: 'Priya Nair', owner: true },
    };

    renderPanel(fakes());

    expect(await screen.findByText(/In the call · 2/)).toBeInTheDocument();
    expect(screen.getByText('Priya Nair')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('⚠⚠ a guest whose DECODED claim is in the room moves OUT of "Invited"', async () => {
    const guestId = '11111111-2222-4333-8444-555555555555';
    dailyState.participantIds = ['local-session', 'guest-session'];
    dailyState.participants = {
      'local-session': { user_name: 'You', owner: false },
      'guest-session': {
        user_name: 'Dana Okoro',
        owner: false,
        // The Decision-1 encoding: `g` + the uuid with hyphens stripped, lowercased.
        user_id: `g${guestId.replaceAll('-', '')}`,
      },
    };

    renderPanel(fakes({ guests: [guest({ id: guestId })] }));

    expect(await screen.findByText(/In the call · 2/)).toBeInTheDocument();
    expect(screen.queryByText(/Invited ·/)).not.toBeInTheDocument();
  });

  it('⚠ FAIL-CLOSED: an UNRECOGNISED claim leaves the roster row where it was', async () => {
    // `presentGuestIdsFrom` returns nothing for a claim this platform did not mint, so the
    // guest stays "Invited" rather than being matched to the wrong tile.
    const guestId = '11111111-2222-4333-8444-555555555555';
    dailyState.participantIds = ['local-session', 'stranger-session'];
    dailyState.participants = {
      'local-session': { user_name: 'You', owner: false },
      'stranger-session': { user_name: 'Someone', owner: false, user_id: guestId },
    };

    renderPanel(fakes({ guests: [guest({ id: guestId })] }));

    expect(await screen.findByText(/Invited · 1/)).toBeInTheDocument();
  });
});

/**
 * ⚠⚠ THE POLITE LIVE REGION THE PLAN BANNED `aria-busy` FOR — AND THEN NEVER SPECIFIED.
 *
 * Every component docblock on this surface cited "the live-region announcement" as the reason
 * `aria-busy` is forbidden. No such region reached this subtree: the only named vehicle was
 * Sonner (a VISUAL toast), and the panel additionally claimed `aria-modal`, which hid the
 * frame's §16 region from AT entirely. So the ban protected nothing.
 *
 * The fix routes panel outcomes into the frame's EXISTING §16 region rather than adding a
 * second one — two `aria-live` nodes on one surface race, and a screen reader queues both.
 */
describe('PeoplePanel — ⚠⚠ §16, announcing through the frame`s ONE live region', () => {
  it('announces an admit, NAMING the person', async () => {
    const user = userEvent.setup();
    const fake = fakes({ guests: [KNOCKER], canHost: true });

    renderPanel(fake);
    await user.click(await screen.findByRole('button', { name: 'Admit Taylor Wu' }));

    await waitFor(() => expect(onAnnounce).toHaveBeenCalledWith('Taylor Wu is in.'));
    // ⚠ THE SAME SENTENCE IN BOTH CHANNELS. Two wordings for one event makes a support
    // conversation ("it said X" / "no, it says Y") unanswerable.
    expect(toast.success).toHaveBeenCalledWith('Taylor Wu is in.');
  });

  it('announces a RACE as the informational sentence it is', async () => {
    const user = userEvent.setup();
    const fake = fakes({ guests: [KNOCKER], canHost: true });
    fake.decideAdmission.mockResolvedValue({
      success: false,
      error: 'Someone else already decided this.',
      outcome: 'already_decided',
    });

    renderPanel(fake);
    await user.click(await screen.findByRole('button', { name: 'Deny Taylor Wu' }));

    await waitFor(() =>
      expect(onAnnounce).toHaveBeenCalledWith('Someone else already decided this.')
    );
  });

  /**
   * ⚠⚠ THE ONE ANNOUNCEMENT NOTHING ELSE PRODUCES. Every other message follows a click, so the
   * person knows something happened. A knock arrives on a POLL, up to 10 seconds late, with no
   * motion beyond a row appearing in a possibly-scrolled list.
   */
  it('⚠⚠ announces a NEW ARRIVAL in the queue — the only event with no click behind it', async () => {
    const user = userEvent.setup();
    // ⚠ OPENS ON AN ALREADY-POPULATED QUEUE, so the first tick's silence is a real assertion
    // rather than an artefact of there being nothing to announce.
    const fake = fakes({ guests: [KNOCKER], canHost: true });

    renderPanel(fake);
    await screen.findByText(/Waiting to join · 1/);
    expect(onAnnounce).not.toHaveBeenCalled();

    // A second knock lands. Every mutation forces an immediate refetch, and the error card's
    // Retry is the only refetch a test can drive without waiting out the 10s schedule — so
    // drive it through the roster read the panel already re-runs after an invite.
    const second = guest({
      id: 'knock-2',
      name: 'Priya Nair',
      displayName: 'Priya Nair',
      admission: 'pending',
      inviteChannel: 'link',
    });
    fake.loadGuests.mockResolvedValue({
      success: true,
      data: { guests: [KNOCKER, second], canHost: true, participantCount: 4, participantCap: 10 },
    });

    await user.click(screen.getByRole('button', { name: /add people/i }));
    await user.type(screen.getByLabelText(/email address to invite/i), 'sam@northwind.example');
    await user.click(screen.getByRole('button', { name: /send invite/i }));

    await waitFor(() => expect(onAnnounce).toHaveBeenCalledWith('Priya Nair is waiting to join.'));
  });
});

describe('PeoplePanel — accessibility', () => {
  it('has no axe violations with a queue, an invite and a stranded row', async () => {
    const container = renderPanel(
      fakes({
        canHost: true,
        guests: [
          KNOCKER,
          guest({ id: 'g1' }),
          guest({
            id: 'g2',
            admission: 'admitted',
            inviteChannel: 'link',
            admissionDecidedAt: '2020-01-01T00:00:00.000Z',
          }),
        ],
      })
    );

    await screen.findByText(/Waiting to join/);
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ── BAL-476 (R3) — the Remove affordance ─────────────────────────────────────────────────

describe('PeoplePanel — Remove (BAL-476)', () => {
  const GUEST_ID = '11111111-2222-4333-8444-555555555555';

  const inCallGuest = guest({
    id: GUEST_ID,
    name: 'Dana Okoro',
    displayName: 'Dana Okoro',
    admission: 'admitted',
  });

  /** Puts `inCallGuest` in the live Daily roster, so the row lands in "In the call". */
  function putInCall(): void {
    dailyState.participantIds = ['local-session', 'guest-session'];
    dailyState.participants = {
      'local-session': { user_name: 'You', owner: false },
      'guest-session': {
        user_name: 'Dana Okoro',
        owner: false,
        user_id: `g${GUEST_ID.replaceAll('-', '')}`,
      },
    };
  }

  it('⚠ renders on a SAME-PARTY row, naming the person in the accessible name', async () => {
    renderPanel(fakes({ guests: [inCallGuest], viewerSide: 'client' }));

    expect(await screen.findByRole('button', { name: 'Remove Dana Okoro' })).toBeInTheDocument();
  });

  /**
   * ⚠ ABSENT, NOT DISABLED, for a guest the OTHER party invited — the panel's slot rule. It is
   * a courtesy that saves a guaranteed 404, never the enforcement.
   */
  it('⚠ is ABSENT on a CROSS-PARTY row', async () => {
    renderPanel(fakes({ guests: [inCallGuest], viewerSide: 'expert' }));

    await screen.findByText(/Admitted · not yet arrived · 1/);
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
  });

  it.each(['in_call', 'invited', 'not_arrived'] as const)(
    'renders on the %s section',
    async (state) => {
      if (state === 'in_call') putInCall();
      const row =
        state === 'invited' ? { ...inCallGuest, admission: 'pre_admitted' as const } : inCallGuest;

      renderPanel(fakes({ guests: [row], viewerSide: 'client' }));

      expect(await screen.findByRole('button', { name: 'Remove Dana Okoro' })).toBeInTheDocument();
    }
  );

  /**
   * ⚠⚠ DELIBERATELY EXCLUDED FROM THE LOBBY QUEUE. Deny already produces the identical practical
   * outcome and IS host-gated (`host_meetings`); Remove is gated on same-party membership alone,
   * so offering both would let a non-host achieve through Remove what Deny reserves for hosts.
   */
  it('⚠⚠ is NEVER offered on a "Waiting to join" row', async () => {
    renderPanel(fakes({ guests: [KNOCKER], canHost: true, viewerSide: 'client' }));

    await screen.findByText(/Waiting to join · 1/);
    expect(screen.getByRole('button', { name: /^Admit /i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove /i })).not.toBeInTheDocument();
  });

  it('⚠ VARIANT A for an in-call row — "disconnected right away"', async () => {
    const user = userEvent.setup();
    putInCall();
    renderPanel(fakes({ guests: [inCallGuest], viewerSide: 'client' }));

    await user.click(await screen.findByRole('button', { name: 'Remove Dana Okoro' }));

    expect(
      await screen.findByRole('heading', { name: 'Remove Dana Okoro from this call?' })
    ).toBeInTheDocument();
    expect(screen.getByText(/will be disconnected right away/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove from call' })).toBeInTheDocument();
  });

  it('⚠ VARIANT B for a row that never joined — "nothing to disconnect"', async () => {
    const user = userEvent.setup();
    renderPanel(
      fakes({
        guests: [{ ...inCallGuest, admission: 'pre_admitted' }],
        viewerSide: 'client',
      })
    );

    await user.click(await screen.findByRole('button', { name: 'Remove Dana Okoro' }));

    expect(
      await screen.findByRole('heading', { name: "Withdraw Dana Okoro's invite?" })
    ).toBeInTheDocument();
    expect(
      screen.getByText(/hasn't joined yet, so there's nothing to disconnect/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw invite' })).toBeInTheDocument();
  });

  /** ⚠ R2 — nobody else is told anything, so the dialog must not imply otherwise. */
  it('⚠ the confirm copy says NOTHING about the remaining party', async () => {
    const user = userEvent.setup();
    putInCall();
    renderPanel(fakes({ guests: [inCallGuest], viewerSide: 'client' }));

    await user.click(await screen.findByRole('button', { name: 'Remove Dana Okoro' }));
    await screen.findByRole('button', { name: 'Remove from call' });

    const text = dialogText();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/everyone will be notified/i);
    for (const adversarial of ['kick', 'boot', 'ban']) {
      expect(text.toLowerCase()).not.toContain(adversarial);
    }
  });

  it('a success closes the dialog, toasts, tracks and refetches', async () => {
    const user = userEvent.setup();
    putInCall();
    const fake = fakes({ guests: [inCallGuest], viewerSide: 'client' });
    renderPanel(fake);

    await user.click(await screen.findByRole('button', { name: 'Remove Dana Okoro' }));
    await user.click(await screen.findByRole('button', { name: 'Remove from call' }));

    await waitFor(() => expect(fake.removeGuest).toHaveBeenCalledWith(GUEST_ID));
    expect(toast.success).toHaveBeenCalledWith('Dana Okoro has been removed from the call.');
    expect(onAnnounce).toHaveBeenCalledWith('Dana Okoro has been removed from the call.');
    expect(track).toHaveBeenCalledWith(MEETING_PANEL_EVENTS.GUEST_REMOVED, {
      ...MEETING_PROPS,
      state: 'in_call',
      outcome: 'ok',
    });
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Remove Dana Okoro from this call?' })
      ).not.toBeInTheDocument()
    );
    // ⚠ Two loads: the initial poll and the post-mutation refetch.
    await waitFor(() => expect(fake.loadGuests.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('a withdrawal toasts the invite-shaped sentence and tracks its own state', async () => {
    const user = userEvent.setup();
    const fake = fakes({
      guests: [{ ...inCallGuest, admission: 'pre_admitted' }],
      viewerSide: 'client',
    });
    renderPanel(fake);

    await user.click(await screen.findByRole('button', { name: 'Remove Dana Okoro' }));
    await user.click(await screen.findByRole('button', { name: 'Withdraw invite' }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Dana Okoro's invite has been withdrawn.")
    );
    expect(track).toHaveBeenCalledWith(MEETING_PANEL_EVENTS.GUEST_REMOVED, {
      ...MEETING_PROPS,
      state: 'invited',
      outcome: 'ok',
    });
  });

  /**
   * ⚠⚠ ONLY A SUCCESS CLOSES THE DIALOG — the `endForEveryone` precedent. A failure keeps the
   * person's place, with the toast on top and the button reset.
   */
  it('⚠ a FAILURE keeps the dialog open, toasts the error, and still refetches', async () => {
    const user = userEvent.setup();
    putInCall();
    const fake = fakes({ guests: [inCallGuest], viewerSide: 'client' });
    fake.removeGuest.mockResolvedValue({
      success: false,
      error: 'That person is no longer in the list.',
    });
    renderPanel(fake);

    await user.click(await screen.findByRole('button', { name: 'Remove Dana Okoro' }));
    await user.click(await screen.findByRole('button', { name: 'Remove from call' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('That person is no longer in the list.')
    );
    expect(
      screen.getByRole('heading', { name: 'Remove Dana Okoro from this call?' })
    ).toBeInTheDocument();
    expect(track).toHaveBeenCalledWith(MEETING_PANEL_EVENTS.GUEST_REMOVED, {
      ...MEETING_PROPS,
      state: 'in_call',
      outcome: 'failed',
    });
    await waitFor(() => expect(fake.loadGuests.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('⚠ Cancel dismisses without removing anything', async () => {
    const user = userEvent.setup();
    const fake = fakes({ guests: [inCallGuest], viewerSide: 'client' });
    renderPanel(fake);

    await user.click(await screen.findByRole('button', { name: 'Remove Dana Okoro' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove from call' })).not.toBeInTheDocument()
    );
    expect(fake.removeGuest).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE DIALOG PORTALS OUT OF THE PANEL, so every assertion about its copy has to read the
   * dialog itself. Reading `container.textContent` would pass vacuously — the text simply is not
   * in there.
   */
  function dialogText(): string {
    return screen.getByRole('alertdialog').textContent ?? '';
  }

  it('⚠ no address reaches the dialog, even from a bait-carrying row', async () => {
    const user = userEvent.setup();
    renderPanel(
      fakes({
        guests: [{ ...inCallGuest, inviteChannel: 'link', email: BAIT_EMAIL }],
        // ⚠ `canHost`, NOT `viewerSide` — a `link` row follows the host rule (BAL-476): its
        // `party` is the lobby writer's placeholder, never a resolved side.
        canHost: true,
        viewerSide: 'expert',
      })
    );

    await user.click(await screen.findByRole('button', { name: 'Remove Dana Okoro' }));
    // ⚠ `Remove`, NOT `Withdraw invite` — a `link` row never had an invite. See the link variants.
    await screen.findByRole('button', { name: 'Remove' });

    const text = dialogText();
    expect(text.length).toBeGreaterThan(0);
    expect(containsEmailAddress(text)).toBe(false);
  });

  // ── the LINK variants: three claims the server does not honour for a lobby guest ──────

  /**
   * ⚠⚠ THE DIALOG HALF OF THE LINK-ROW RULE. `removeGuest` sends a `link` row NEITHER the removal
   * email NOR the `METHOD:CANCEL`, so promising either would tell the host something the server
   * deliberately does not do — on the very path the host gate opened up. And "invite" names a
   * thing a lobby visitor never had: they knocked with a forwarded meeting URL.
   */
  const LINK_GUEST = {
    ...inCallGuest,
    inviteChannel: 'link' as const,
    displayName: 'Taylor Wu',
    name: 'Taylor Wu',
  };

  it.each([
    ['in the call', true],
    ['admitted but not arrived', false],
  ])(
    '⚠⚠ a LINK row (%s) promises NO email, NO calendar removal, and says no "invite"',
    async (_label, present) => {
      const user = userEvent.setup();
      if (present) putInCall();
      renderPanel(
        fakes({
          guests: [present ? { ...LINK_GUEST, id: GUEST_ID } : LINK_GUEST],
          canHost: true,
          viewerSide: 'expert',
        })
      );

      await user.click(await screen.findByRole('button', { name: 'Remove Taylor Wu' }));
      await screen.findByRole('button', { name: present ? 'Remove from call' : 'Remove' });

      const text = dialogText();
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/let them know by email/i);
      expect(text).not.toMatch(/come off their calendar/i);
      expect(text).not.toMatch(/invite/i);
      // ⚠ AND IT SAYS THE PART THE HOST HAS TO ACT ON.
      expect(text).toMatch(/We won't email them/i);
      expect(text).toMatch(/can't be undone/i);
    }
  );

  it('⚠ an EMAIL row STILL promises both — the server still honours them', async () => {
    const user = userEvent.setup();
    putInCall();
    renderPanel(fakes({ guests: [inCallGuest], viewerSide: 'client' }));

    await user.click(await screen.findByRole('button', { name: 'Remove Dana Okoro' }));
    await screen.findByRole('button', { name: 'Remove from call' });

    const text = dialogText();
    expect(text).toMatch(/We'll let them know by email/i);
    expect(text).toMatch(/the event will come off their calendar/i);
    expect(text).toMatch(/rejoin with this invite/i);
  });

  it('⚠ the LINK success toast names no invite either', async () => {
    const user = userEvent.setup();
    const fake = fakes({ guests: [LINK_GUEST], canHost: true, viewerSide: 'expert' });
    renderPanel(fake);

    await user.click(await screen.findByRole('button', { name: 'Remove Taylor Wu' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Taylor Wu has been removed.'));
  });

  /**
   * ⚠ R-5 — ABSENT, NOT AN EMPTY WRAPPER. A row in "Admitted · not yet arrived" that can offer
   * NEITHER affordance (cross-party, so no Remove; inside the grace period, so no Re-send) must
   * render no action node at all — the panel slot rule. An unconditional `<div>` put an empty
   * flex box in every such row.
   */
  it('⚠ a not-arrived row with NEITHER affordance renders no action wrapper at all', async () => {
    const container = renderPanel(
      fakes({
        guests: [{ ...inCallGuest, admissionDecidedAt: new Date().toISOString() }],
        viewerSide: 'expert',
      })
    );

    await screen.findByText(/Admitted · not yet arrived · 1/);
    expect(screen.queryByRole('button', { name: /^Remove /i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /re-send/i })).not.toBeInTheDocument();
    expect(container.querySelectorAll('[class*="gap-1.5"]')).toHaveLength(0);
  });

  it('⚠ a not-arrived row with BOTH affordances groups them in one flex wrapper', async () => {
    const container = renderPanel(
      fakes({
        guests: [{ ...inCallGuest, admissionDecidedAt: '2020-01-01T00:00:00.000Z' }],
        viewerSide: 'client',
      })
    );

    await screen.findByRole('button', { name: 'Remove Dana Okoro' });
    expect(
      screen.getByRole('button', { name: 'Re-send the join link to Dana Okoro' })
    ).toBeInTheDocument();
    expect(container.querySelectorAll('[class*="gap-1.5"]')).toHaveLength(1);
  });

  it('has no accessibility violations with the control rendered', async () => {
    const container = renderPanel(fakes({ guests: [inCallGuest], viewerSide: 'client' }));
    await screen.findByRole('button', { name: 'Remove Dana Okoro' });

    expect(await axe(container)).toHaveNoViolations();
  });
});
