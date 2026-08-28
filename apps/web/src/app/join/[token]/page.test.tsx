import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { axe } from 'jest-axe';
import { render, screen } from '@/test/utils';

const RAW_TOKEN = 'k7Qm2ZtXpA9wLd3Vc1Rb8YvNhKsE0uJt';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');

const GUEST_ID = 'a0000000-0000-4000-8000-00000000000a';
const OTHER_GUEST_ID = 'a0000000-0000-4000-8000-00000000000b';
const MEETING_ID = 'b0000000-0000-4000-8000-00000000000c';
const INVITER_ID = 'c0000000-0000-4000-8000-00000000000d';
const ENGAGEMENT_ID = 'd0000000-0000-4000-8000-00000000000e';
const COMPANY_ID = 'e0000000-0000-4000-8000-00000000000f';
const EXPERT_PROFILE_ID = 'f0000000-0000-4000-8000-000000000010';
const EXPERT_USER_ID = 'f0000000-0000-4000-8000-000000000011';
const AGENCY_ID = 'f0000000-0000-4000-8000-000000000012';

const GUEST_EMAIL = 'priya@northwind.com';
const OTHER_GUEST_EMAIL = 'tom@brightline.io';

const {
  mockFindByTokenHash,
  mockRecordAccess,
  mockListLiveByMeeting,
  mockListContexts,
  mockFindEngagement,
  mockFindCompany,
  mockFindProfile,
  mockAgencySummary,
  mockFindNames,
  mockRevoke,
} = vi.hoisted(() => ({
  mockFindByTokenHash: vi.fn(),
  mockRecordAccess: vi.fn(),
  mockListLiveByMeeting: vi.fn(),
  mockListContexts: vi.fn(),
  mockFindEngagement: vi.fn(),
  mockFindCompany: vi.fn(),
  mockFindProfile: vi.fn(),
  mockAgencySummary: vi.fn(),
  mockFindNames: vi.fn(),
  mockRevoke: vi.fn(),
}));

vi.mock('@balo/db', () => ({
  meetingGuestsRepository: {
    findLiveByTokenHash: (...a: unknown[]) => mockFindByTokenHash(...a),
    recordAccess: (...a: unknown[]) => mockRecordAccess(...a),
    listLiveByMeeting: (...a: unknown[]) => mockListLiveByMeeting(...a),
    // Present ONLY so the never-mutates assertion has something to observe. Nothing on
    // this page may ever call it.
    revoke: (...a: unknown[]) => mockRevoke(...a),
  },
  meetingContextsRepository: { listByMeeting: (...a: unknown[]) => mockListContexts(...a) },
  engagementsRepository: { findById: (...a: unknown[]) => mockFindEngagement(...a) },
  companiesRepository: { findById: (...a: unknown[]) => mockFindCompany(...a) },
  expertsRepository: { findProfileById: (...a: unknown[]) => mockFindProfile(...a) },
  agenciesRepository: { getSummaryById: (...a: unknown[]) => mockAgencySummary(...a) },
  usersRepository: { findNamesByIds: (...a: unknown[]) => mockFindNames(...a) },
}));

const mockHeaders = vi.fn();
vi.mock('next/headers', () => ({ headers: () => mockHeaders() }));

const mockCheckLimit = vi.fn();
vi.mock('@/lib/rate-limit/memory-window', () => ({
  checkMemoryLimit: (...a: unknown[]) => mockCheckLimit(...a),
}));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
    GUEST_SERVER_EVENTS: events.GUEST_SERVER_EVENTS,
  };
});

import JoinLandingPage from './page';

/** ⚠ `params` is a PROMISE — apps/web is Next 16. A plain object here would false-green. */
function pageProps(token = RAW_TOKEN): { params: Promise<{ token: string }> } {
  return { params: Promise.resolve({ token }) };
}

interface GuestOverrides {
  party?: string;
  participationRole?: string;
  accessScope?: string;
  accessCount?: number;
  name?: string | null;
}

function primeHappyPath(overrides: GuestOverrides & { meetingStatus?: string } = {}): void {
  mockCheckLimit.mockReturnValue(true);
  mockHeaders.mockResolvedValue(new Headers({ 'x-forwarded-for': '1.2.3.4' }));
  mockFindByTokenHash.mockResolvedValue({
    guest: {
      id: GUEST_ID,
      meetingId: MEETING_ID,
      tokenHash: TOKEN_HASH,
      email: GUEST_EMAIL,
      name: overrides.name === undefined ? 'Priya' : overrides.name,
      party: overrides.party ?? 'client',
      participationRole: overrides.participationRole ?? 'guest',
      accessScope: overrides.accessScope ?? 'engagement',
      accessCount: overrides.accessCount ?? 0,
      invitedById: INVITER_ID,
      expiresAt: new Date('2026-08-11T00:00:00.000Z'),
    },
    meeting: {
      id: MEETING_ID,
      status: overrides.meetingStatus ?? 'scheduled',
      scheduledStart: new Date('2026-08-04T04:00:00.000Z'),
      scheduledEnd: new Date('2026-08-04T05:00:00.000Z'),
    },
  });
  mockListContexts.mockResolvedValue([{ contextType: 'case', contextId: ENGAGEMENT_ID }]);
  mockFindEngagement.mockResolvedValue({
    id: ENGAGEMENT_ID,
    companyId: COMPANY_ID,
    expertProfileId: EXPERT_PROFILE_ID,
  });
  mockFindCompany.mockResolvedValue({ id: COMPANY_ID, name: 'Northwind Industrial' });
  mockFindProfile.mockResolvedValue({
    id: EXPERT_PROFILE_ID,
    type: 'agency',
    agencyId: AGENCY_ID,
    userId: EXPERT_USER_ID,
  });
  mockAgencySummary.mockResolvedValue({ id: AGENCY_ID, name: 'CloudPeak Consulting' });
  mockListLiveByMeeting.mockResolvedValue([
    { id: GUEST_ID, name: 'Priya', email: GUEST_EMAIL, party: 'client' },
    { id: OTHER_GUEST_ID, name: 'Tom', email: OTHER_GUEST_EMAIL, party: 'client' },
  ]);
  mockFindNames.mockResolvedValue([{ id: INVITER_ID, firstName: 'Dana', lastName: 'Okoro' }]);
  mockRecordAccess.mockResolvedValue(undefined);
}

async function renderPage(props = pageProps()): Promise<HTMLElement> {
  const { container } = render(await JoinLandingPage(props));
  return container;
}

/**
 * Every `@` in the rendered text that is NOT space-delimited — i.e. address-shaped.
 *
 * ⚠ An indexOf scan, deliberately NOT a regex: an email-shaped pattern over
 * attacker-influenceable text (a guest's own name is user-supplied) is exactly the
 * super-linear-backtracking shape SonarCloud S5852 and `regexp/no-super-linear-move` flag.
 * The ONLY legitimate `@` this page renders is the attribution separator, which always has
 * a space on both sides ("Dana Okoro @ Northwind Industrial") — so "an `@` with a non-space
 * neighbour" catches every address without one.
 */
function addressShapedAtSigns(text: string): string[] {
  const found: string[] = [];
  let i = text.indexOf('@');
  while (i !== -1) {
    if (text.charAt(i - 1) !== ' ' || text.charAt(i + 1) !== ' ') {
      found.push(text.slice(Math.max(0, i - 12), i + 12));
    }
    i = text.indexOf('@', i + 1);
  }
  return found;
}

beforeEach(() => vi.clearAllMocks());

describe('JoinLandingPage', () => {
  it('renders the invitation for a live token', async () => {
    primeHappyPath();
    const container = await renderPage();

    expect(screen.getByRole('heading', { name: "You're invited" })).toBeInTheDocument();
    expect(container.textContent).toContain('Consultation');
  });

  it('resolves the token by HASH — the raw token never reaches the repository', async () => {
    primeHappyPath();
    await renderPage();

    expect(mockFindByTokenHash).toHaveBeenCalledWith(TOKEN_HASH);
    expect(mockFindByTokenHash).not.toHaveBeenCalledWith(RAW_TOKEN);
  });

  /**
   * ⚠ THE TOKEN IS IN THE URL BECAUSE IT HAS TO BE. Putting it in the BODY as well —
   * "your link: …" — invites a screenshot into a group chat, and a join token is
   * deliberately not single-use, so that screenshot stays live for the whole window.
   */
  it('never renders the raw token as copyable text', async () => {
    primeHappyPath();
    const container = await renderPage();

    expect(container.textContent ?? '').not.toContain(RAW_TOKEN);
    expect(container.innerHTML).not.toContain(RAW_TOKEN);
    expect(container.innerHTML).not.toContain(TOKEN_HASH);
  });

  // ── Attribution ────────────────────────────────────────────────────────────
  // Parameterized because these two are the SAME test with a different needle — same
  // fixture, same render, one `toContain`. The degradation case below is deliberately NOT
  // folded in: it has its own fixture and five assertions, and collapsing it here would
  // hide which behaviour broke behind a shared test name.
  it.each([
    ['names the inviter retrospectively as person @ org', 'Dana Okoro @ Northwind Industrial'],
    ['shows the expert party label to a client-side guest', 'CloudPeak Consulting'],
  ])('%s', async (_case, expected) => {
    primeHappyPath();
    const container = await renderPage();

    expect(container.textContent).toContain(expected);
  });

  it('drops the "@ org" clause rather than inventing one when the org is unresolvable', async () => {
    primeHappyPath();
    // A request-grain context names a project_request, not an engagement — so there is no
    // company_id to read. Degrade, never bail.
    mockListContexts.mockResolvedValue([
      { contextType: 'project_discovery', contextId: ENGAGEMENT_ID },
    ]);
    const container = await renderPage();

    expect(mockFindEngagement).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Dana Okoro');
    expect(container.textContent).not.toContain('Dana Okoro @');
    // …and it still renders. A thin unrelated read must NEVER become the not-active card.
    expect(screen.getByRole('heading', { name: "You're invited" })).toBeInTheDocument();
    expect(container.textContent).toContain('Discovery call');
  });

  it('mirrors the sides for an expert-side guest (org = the agency, counterparty = the company)', async () => {
    primeHappyPath({ party: 'expert' });
    const container = await renderPage();

    expect(container.textContent).toContain('Dana Okoro @ CloudPeak Consulting');
    expect(container.textContent).toContain('Northwind Industrial');
  });

  // ── The counterparty-concealment rule, applied to EVERYBODY ────────────────
  /**
   * ⚠ STRICTER THAN `projectGuestForViewer`, ON PURPOSE. That helper's same-party branch
   * returns the address (its audience is a party MEMBER who already sees the roster).
   * This page's reader is an external person holding a link, so the cross-party rule is
   * applied to everyone — names cross, addresses never.
   */
  it('renders other participants by NAME and never an email address', async () => {
    primeHappyPath();
    const container = await renderPage();

    expect(container.textContent).toContain('Tom');
    expect(container.textContent).not.toContain(OTHER_GUEST_EMAIL);
    expect(container.textContent).not.toContain(GUEST_EMAIL);
    // …and not any OTHER address either. The only legitimate `@` on this page is the
    // attribution separator, which is space-delimited ("Dana @ Northwind").
    expect(addressShapedAtSigns(container.textContent ?? '')).toEqual([]);
  });

  it('falls back to the neutral "Guest" literal for an unnamed participant, never their address', async () => {
    primeHappyPath();
    mockListLiveByMeeting.mockResolvedValue([
      { id: GUEST_ID, name: 'Priya', email: GUEST_EMAIL, party: 'client' },
      { id: OTHER_GUEST_ID, name: null, email: OTHER_GUEST_EMAIL, party: 'expert' },
    ]);
    const container = await renderPage();

    expect(container.textContent).toContain('Guest');
    expect(container.textContent).not.toContain(OTHER_GUEST_EMAIL);
    expect(container.textContent).not.toContain('tom');
  });

  /**
   * ⚠⚠ THE ROW IS OMITTED WHEN EMPTY, AND IT SAYS "Other guests" — BOTH ARE CORRECTIONS OF
   * COPY THAT STATED SOMETHING FALSE.
   *
   * `otherGuestNames` comes from `listLiveByMeeting`, and `meeting_guests` holds NON-USER
   * guests ONLY — the booker and the delivering expert are structurally absent from that
   * table. So "Others invited: Just you" told the FIRST guest on any call that they were
   * alone on a call with at least two other people, and contradicted the "You'll be
   * meeting: {org}" row rendered two lines above it.
   */
  it('OMITS the guest row entirely when the reader is the only guest — never "Just you"', async () => {
    primeHappyPath();
    mockListLiveByMeeting.mockResolvedValue([
      { id: GUEST_ID, name: 'Priya', email: GUEST_EMAIL, party: 'client' },
    ]);
    const container = await renderPage();
    const text = container.textContent ?? '';

    expect(text).not.toContain('Just you');
    expect(text).not.toContain('Other guests');
    expect(text).not.toContain('Others invited');
    // The row it used to contradict is still there.
    expect(text).toContain("You'll be meeting");
  });

  it('lists the OTHER guests, excluding the reader, under an honest label', async () => {
    primeHappyPath();
    const container = await renderPage();
    const text = container.textContent ?? '';

    expect(text).toContain('Other guests');
    expect(text).toContain('Tom');
    expect(text).not.toContain('Others invited');
  });

  /**
   * ⚠ Guests do not change what anybody pays — billing is per-minute of EXPERT time, never
   * per-seat — and a guest is the last audience that should learn what anybody pays.
   */
  it('renders no billing, rate or price line anywhere', async () => {
    primeHappyPath();
    const container = await renderPage();
    const text = container.textContent ?? '';

    for (const forbidden of [
      /\$/,
      /\bAUD\b/,
      /\brate\b/i,
      /\bprice\b/i,
      /\binvoice\b/i,
      /\bcredit/i,
    ]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  /**
   * ⚠⚠ NO DEAD **LINK** — AND THAT HALF OF THE RULE IS PERMANENT, unlike the button half.
   *
   * BAL-129 provisions the Daily room `privacy: 'private'`, so a raw `join_url` anchor is a
   * dead control: the URL admits nobody without a minted token, and following it would drop
   * the guest into Daily's OWN knocking UI, outside Balo's admit/deny flow entirely. That
   * must never appear here.
   *
   * ⚠ THE "no button" HALF WAS BAL-408's PLACEHOLDER AND BAL-132 HAS NOW LANDED IT — the
   * original assertion's own comment said so ("BAL-132 adds the join control to THIS SAME
   * ROUTE"). Loosening it is the correct amendment, not a weakening: it is replaced by a
   * SPECIFIC assertion about what the control does, which is strictly stronger than a count.
   */
  it('offers no dead link, and exactly ONE join control (a button, never an anchor)', async () => {
    primeHappyPath();
    await renderPage();

    // ⚠ STILL ZERO ANCHORS. A `<a href={joinUrl}>` is the failure this pins.
    expect(screen.queryAllByRole('link')).toHaveLength(0);

    // ONE button — the join control, which POSTs to a Server Action. A navigation cannot
    // reach it, which is what `join-link-never-writes.test.ts` requires of anything that
    // changes participation from this route.
    const buttons = screen.queryAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName(/join the call/i);
  });

  /**
   * ⚠ THE RAW TOKEN REACHES THE JOIN CONTROL AS A PROP BUT MUST NEVER BE RENDERED. It is in
   * the URL because it has to be; putting it in the body as well invites a screenshot into a
   * group chat, and the token is deliberately NOT single-use.
   */
  it('never renders the raw token as visible text', async () => {
    primeHappyPath();
    const container = await renderPage();

    expect(container.textContent ?? '').not.toContain(RAW_TOKEN);
  });

  // ── The scheduled window ───────────────────────────────────────────────────
  it('states the window WITH its timezone, so it cannot be silently misread', async () => {
    primeHappyPath();
    const container = await renderPage();

    expect(container.textContent).toContain('4 August 2026');
    expect(container.textContent).toContain('04:00 – 05:00 UTC');
  });

  /**
   * ⚠ THE WEEKDAY IS THE MOST USEFUL TOKEN ON A "CAN I MAKE THIS?" SURFACE, and the invite
   * EMAIL already renders one (`Tue, 1 Sep 2026 · 10:00–11:00 (UTC)`). The landing dropping
   * it made the two descriptions of the same instant disagree on the one field the reader
   * actually reasons with.
   */
  it('leads the date with its WEEKDAY, matching the invite email', async () => {
    primeHappyPath();
    const container = await renderPage();

    expect(container.textContent).toContain('Tuesday, 4 August 2026');
  });

  // ── Semantics ──────────────────────────────────────────────────────────────
  /**
   * ⚠ THE DETAIL ROWS ARE A DESCRIPTION LIST, NOT EIGHT LOOSE PARAGRAPHS. Rendered as
   * unassociated `<p>`s, a screen-reader user heard four labels and four values with
   * nothing tying them together — on a card whose entire content is label/value pairs.
   */
  it('pairs each label with its value as <dt>/<dd> inside a single <dl>', async () => {
    primeHappyPath();
    const container = await renderPage();

    const lists = container.querySelectorAll('dl');
    expect(lists).toHaveLength(1);
    const terms = [...container.querySelectorAll('dt')].map((node) => node.textContent);
    expect(terms).toContain('When');
    expect(terms).toContain('Invited by');
    expect(container.querySelectorAll('dd')).toHaveLength(terms.length);
  });

  /**
   * ⚠ NON-VACUOUS BY CONSTRUCTION. `dlitem` / `definition-list` only fire once a `<dl>` is
   * present, and they are exactly the rules a second nesting level between the `<dl>` and
   * its `<dt>`/`<dd>` would trip — which is why `DetailRow` is a grid rather than the
   * obvious flex row with an inner text `<div>`.
   */
  it('has no axe violations', async () => {
    primeHappyPath();
    const container = await renderPage();

    expect(await axe(container)).toHaveNoViolations();
  });

  // ── The disclosure ─────────────────────────────────────────────────────────
  it('discloses the RETROSPECTIVE reach of an engagement-scoped grant', async () => {
    primeHappyPath({ accessScope: 'engagement' });
    const container = await renderPage();

    expect(container.textContent).toContain('every call in this piece of work');
    expect(container.textContent).toContain('including ones held before you were invited');
  });

  it('discloses the narrow grant for a meeting-scoped guest', async () => {
    primeHappyPath({ accessScope: 'meeting' });
    const container = await renderPage();

    expect(container.textContent).toContain('only see this call and its recap');
    expect(container.textContent).not.toContain('every call in this piece of work');
  });

  it('names the delegate role in place-of terms, gender-neutrally', async () => {
    primeHappyPath({ participationRole: 'delegate' });
    const container = await renderPage();
    const text = container.textContent ?? '';

    expect(text).toContain('in place of the person who booked this call');
    expect(text).not.toMatch(/\b(his|her|he|she)\b/i);
  });

  // ── The ended-meeting asymmetry ────────────────────────────────────────────
  /**
   * ⚠ `findLiveByTokenHash` resolves an `ended` meeting DELIBERATELY, and the asymmetry
   * with the MUTATION gate (which refuses `ended`) is intentional: an ended meeting's link
   * is the guest's only handle on the recap BAL-388 will attach to it. Pinned here so
   * nobody "tidies" the two into agreeing.
   */
  it('still renders for an ENDED meeting, in the past tense', async () => {
    primeHappyPath({ meetingStatus: 'ended' });
    const container = await renderPage();

    expect(
      screen.getByRole('heading', { name: 'This call has already taken place' })
    ).toBeInTheDocument();
    expect(container.textContent).toContain('It was held');
    // …and the disclosure survives: the recap is exactly what an ended link is FOR.
    expect(container.textContent).toContain('every call in this piece of work');
  });

  // ── BAL-439 — the recap link ───────────────────────────────────────────────
  describe('the "View the recap" link', () => {
    it('renders for an ENDED meeting, pointing at the guest recap path', async () => {
      primeHappyPath({ meetingStatus: 'ended' });
      await renderPage();

      const link = screen.getByRole('link', { name: /view the recap/i });
      expect(link).toHaveAttribute('href', `/join/${RAW_TOKEN}/recap/${MEETING_ID}`);
    });

    it('is ABSENT for a meeting that has not ended', async () => {
      primeHappyPath({ meetingStatus: 'scheduled' });
      await renderPage();

      expect(screen.queryByRole('link', { name: /view the recap/i })).not.toBeInTheDocument();
    });

    it('⚠ the "next step" copy no longer promises the recap "appears on this page"', async () => {
      primeHappyPath({ meetingStatus: 'ended' });
      const container = await renderPage();

      expect(container.textContent ?? '').not.toMatch(/appear on this page/i);
      // ⚠⚠ fix-round-1 / S7 — the copy changed again: "Everything from the call is here" sat
      // directly BELOW a "View the recap" button that navigates elsewhere, so "here" was no
      // longer true either.
      expect(container.textContent).not.toMatch(/is here/i);
      expect(container.textContent).toContain(
        'The recap has a short summary and anything that was shared on the call.'
      );
    });
  });

  // ── THE ORACLE PROPERTY ────────────────────────────────────────────────────
  /**
   * ⚠⚠ THE ACCEPTANCE CRITERION. `findLiveByTokenHash` answers `undefined` IDENTICALLY for
   * a wrong / expired / revoked / soft-deleted / denied token AND for a cancelled or
   * soft-deleted meeting — six outcomes the repository cannot tell apart by contract. The
   * page adds the rate-limit bail-out and the corrupt-`party` guard. All eight must render
   * BYTE-IDENTICAL markup, or the response becomes an oracle against a URL that is
   * presented repeatedly and from several devices.
   */
  it('renders BYTE-IDENTICAL markup for every inactive outcome — no oracle', async () => {
    const markup: string[] = [];

    // 1. rate-limited
    primeHappyPath();
    mockCheckLimit.mockReturnValue(false);
    markup.push((await renderPage()).innerHTML);

    // 2–7. every outcome the repository collapses to `undefined`: wrong token, expired,
    // revoked, soft-deleted guest, denied admission, cancelled/soft-deleted meeting.
    for (let i = 0; i < 6; i += 1) {
      primeHappyPath();
      mockFindByTokenHash.mockResolvedValue(undefined);
      markup.push((await renderPage()).innerHTML);
    }

    // 8. a row whose stored hash does not survive the constant-time re-compare
    primeHappyPath();
    mockFindByTokenHash.mockResolvedValue({
      guest: {
        id: GUEST_ID,
        tokenHash: 'f'.repeat(64),
        party: 'client',
        participationRole: 'guest',
        accessScope: 'meeting',
        accessCount: 0,
        invitedById: INVITER_ID,
        expiresAt: new Date('2026-08-11T00:00:00.000Z'),
      },
      meeting: {
        id: MEETING_ID,
        status: 'scheduled',
        scheduledStart: new Date('2026-08-04T04:00:00.000Z'),
        scheduledEnd: new Date('2026-08-04T05:00:00.000Z'),
      },
    });
    markup.push((await renderPage()).innerHTML);

    // 9. a corrupt row whose `party` cannot be placed on a side (the CHECK makes this
    //    unrepresentable — we fail CLOSED rather than guessing).
    primeHappyPath({ party: 'observer' });
    markup.push((await renderPage()).innerHTML);

    expect(markup).toHaveLength(9);
    expect(new Set(markup).size).toBe(1);
    expect(markup[0]).toContain("This link isn't active");
  });

  it('stops at the limiter BEFORE hashing, reading, or stamping', async () => {
    primeHappyPath();
    mockCheckLimit.mockReturnValue(false);

    await renderPage();

    expect(screen.getByText("This link isn't active")).toBeInTheDocument();
    expect(mockFindByTokenHash).not.toHaveBeenCalled();
    expect(mockListContexts).not.toHaveBeenCalled();
    expect(mockRecordAccess).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  // ── recordAccess: success path only ────────────────────────────────────────
  it('stamps the access only AFTER every bail-out has been cleared', async () => {
    primeHappyPath();
    await renderPage();

    expect(mockRecordAccess).toHaveBeenCalledTimes(1);
    expect(mockRecordAccess).toHaveBeenCalledWith(GUEST_ID);
  });

  /**
   * ⚠ Gmail's image proxy, Microsoft Defender Safe Links detonation and MDM prefetch all
   * issue unsolicited GETs against an emailed URL. A failing token must therefore cost
   * ZERO writes no matter how many times it is fetched.
   */
  it('N GETs on a failing token produce ZERO recordAccess calls', async () => {
    primeHappyPath();
    mockFindByTokenHash.mockResolvedValue(undefined);

    for (let i = 0; i < 20; i += 1) {
      await renderPage();
    }

    expect(mockRecordAccess).toHaveBeenCalledTimes(0);
    expect(mockTrack).toHaveBeenCalledTimes(0);
    // Not vacuous: the page really did run 20 times.
    expect(mockFindByTokenHash).toHaveBeenCalledTimes(20);
  });

  it('never mutates a guest row on GET — 20 loads produce ZERO revokes', async () => {
    primeHappyPath();

    for (let i = 0; i < 20; i += 1) {
      await renderPage();
    }

    expect(mockRevoke).toHaveBeenCalledTimes(0);
    expect(mockRecordAccess).toHaveBeenCalledTimes(20);
  });

  // ── Analytics ──────────────────────────────────────────────────────────────
  it('emits guest_invite_opened with the guest row id as distinct_id', async () => {
    primeHappyPath({ accessCount: 0 });
    await renderPage();

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('guest_invite_opened', {
      party: 'client',
      access_scope: 'engagement',
      first_open: true,
      distinct_id: GUEST_ID,
    });
  });

  it('computes first_open from the PRE-increment access_count', async () => {
    primeHappyPath({ accessCount: 3 });
    await renderPage();

    expect(mockTrack).toHaveBeenCalledWith(
      'guest_invite_opened',
      expect.objectContaining({ first_open: false })
    );
  });

  it('reports the SERVER-derived party, never anything a caller could claim', async () => {
    primeHappyPath({ party: 'expert', accessScope: 'meeting' });
    await renderPage();

    expect(mockTrack).toHaveBeenCalledWith(
      'guest_invite_opened',
      expect.objectContaining({ party: 'expert', access_scope: 'meeting' })
    );
  });

  it('emits NOTHING when the token does not resolve', async () => {
    primeHappyPath();
    mockFindByTokenHash.mockResolvedValue(undefined);
    await renderPage();

    expect(mockTrack).not.toHaveBeenCalled();
  });

  // ── Metadata ───────────────────────────────────────────────────────────────
  it('is noindex with a neutral title that names nobody', async () => {
    const { metadata } = await import('./page');

    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.title).toBe('Your invitation — Balo');
    expect(String(metadata.title)).not.toContain('Northwind');
    expect(String(metadata.title)).not.toContain('CloudPeak');
  });

  it('is nodejs runtime and force-dynamic — a per-token, access-stamping page', async () => {
    const mod = await import('./page');

    expect(mod.runtime).toBe('nodejs');
    expect(mod.dynamic).toBe('force-dynamic');
  });
});
