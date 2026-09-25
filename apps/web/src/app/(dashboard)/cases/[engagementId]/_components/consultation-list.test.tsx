import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@/test/utils';
import { cleanup } from '@testing-library/react';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import { VENUE_UNAVAILABLE_NOTE } from '@/lib/meetings/venue-unavailable-copy';
import type {
  CaseConsultationRowView,
  CaseConsultationStateLabel,
} from '@/lib/cases/case-view-types';
import { ConsultationList } from './consultation-list';

/**
 * BAL-421 — the consultation list.
 *
 * ⚠⚠ THE THREE LOAD-BEARING FACTS, EACH OF WHICH A NAIVE REWRITE WOULD BREAK:
 *   1. `no_show_client` and `missed_call` ARE DIFFERENT EVENTS WITH DIFFERENT COPY, per lens.
 *      Folding them into one "not held" label would tell the wronged party that the call
 *      failed without saying who failed to show — so the exact strings are pinned, AND the
 *      two are asserted to differ from each other on the SAME lens. `nobody_joined` is the
 *      third: no wronged party, so it names nobody on either lens.
 *   2. THE RECAP LINK FOLLOWS `recapHref`, NOT `state === 'held'` — the component renders
 *      whatever `recapHref` says, never re-deriving from `state`. `recapHrefOf` emits a href
 *      for every terminal OUTCOME (where the not-held panel explains a no-show), but never for
 *      `cancelled` — that recap has no money block or artifacts to show.
 *   3. THE CONTENT INDICATORS DO stay under `held` — the exact inverse of (2), and a real
 *      divergence rather than an oversight: a transcript or file count on a call that never
 *      happened would promise artefacts that cannot exist.
 *
 * There is deliberately NO empty-state test: booking is what CREATES a case (BAL-400) and a
 * cancelled consultation is MARKED rather than deleted, so a zero-row case is unreachable.
 */

const trackMock = vi.mocked(track);

const COUNTERPARTY = 'Amara';
const LENSES = ['client', 'expert'] as const;

function makeRow(overrides: Partial<CaseConsultationRowView> = {}): CaseConsultationRowView {
  return {
    meetingId: 'm-1',
    ordinal: 1,
    state: 'held',
    scheduledStartIso: '2026-06-12T09:00:00.000Z',
    startedAtIso: '2026-06-12T09:00:00.000Z',
    durationMinutes: 45,
    recapHref: '/meetings/m-1?from=case_surface',
    actionItemCount: 0,
    fileCount: 0,
    hasTranscript: false,
    hasRecording: false,
    // Defaults OFF so every existing case here still asserts a row with no kebab.
    canReschedule: false,
    canProposeReschedule: false,
    canCancel: false,
    canInvite: false,
    guestCount: 0,
    scheduledMinutes: 30,
    live: false,
    // BAL-581 — row contract: `false` on every non-upcoming row (the default `state: 'held'`
    // here is one), matching what `mapCaseConsultations` actually emits.
    roomReady: false,
    ...overrides,
  };
}

function renderList(
  consultations: readonly CaseConsultationRowView[],
  lens: 'client' | 'expert' = 'client',
  onRowAction: (
    verb: string,
    row: CaseConsultationRowView,
    slot: 'menu' | 'guests'
  ) => void = vi.fn(),
  registerTrigger: (
    meetingId: string,
    slot: 'menu' | 'guests',
    node: HTMLButtonElement | null
  ) => void = vi.fn()
) {
  return render(
    <ConsultationList
      consultations={consultations}
      lens={lens}
      counterpartyLabel={COUNTERPARTY}
      onRowAction={onRowAction}
      registerTrigger={registerTrigger}
    />
  );
}

/**
 * Every note the component can emit, on either lens. Counting matches across this catalogue is
 * how "exactly one note" and "no note at all" become assertions that can genuinely fail — a
 * component that emitted a SECOND state's note alongside the right one would still satisfy a
 * bare `getByText`.
 */
const ALL_NOTES: readonly string[] = [
  'Happening now',
  'Cancelled — nothing charged',
  `${COUNTERPARTY} waited — billed at the minimum`,
  "Client didn't join — settled at the minimum",
  `${COUNTERPARTY} wasn't able to join`,
  "The call didn't start",
  'Neither side joined this call',
  VENUE_UNAVAILABLE_NOTE,
  'Outcome not recorded',
  // Item 13 — `pending_reschedule` (BAL-411), the 8th state; §D4 flagged it as NOT
  // compile-forced (`stateNote`'s `default: return null`), so nothing but a test catches a
  // future regression here.
  `${COUNTERPARTY} suggested some new times — see above`,
  'Waiting on a reply to your suggested times',
];

function renderedNotes(): string[] {
  return ALL_NOTES.filter((note) => screen.queryAllByText(note).length > 0);
}

/** The rendered rows, as the `div` each `li` wraps (that div owns the `last` border branch). */
function rowElements(): HTMLElement[] {
  return screen.getAllByRole('listitem').map((item) => {
    const { firstElementChild } = item;
    if (!(firstElementChild instanceof HTMLElement)) {
      throw new Error('a consultation list item rendered no row element');
    }
    return firstElementChild;
  });
}

function firstRow(): HTMLElement {
  const [first] = rowElements();
  if (first === undefined) throw new Error('no consultation row rendered');
  return first;
}

/** The first row's state badge — the `aria-hidden` span carrying the muted/primary treatment. */
function firstStateBadge(): HTMLElement {
  const badge = firstRow().querySelector('span[aria-hidden="true"]');
  if (!(badge instanceof HTMLElement)) throw new Error('the row rendered no state badge');
  return badge;
}

/**
 * The first row's `<time>`. Queried as an element rather than by text because `LocalDateTime`
 * appends an `sr-only` zone suffix INSIDE the element ("12 Jun (UTC)") — a `getByText('12 Jun')`
 * finds nothing, and a substring regex matches the wrapping span too.
 */
function firstTimeElement(): HTMLElement {
  const time = firstRow().querySelector('time');
  if (!(time instanceof HTMLElement)) throw new Error('the row rendered no <time>');
  return time;
}

beforeEach(() => {
  trackMock.mockClear();
});

// ── the state × lens sweep ───────────────────────────────────────────────────────────────

interface StateCase {
  readonly state: CaseConsultationStateLabel;
  /** `STATE_PRESENTATION[state].muted` — the treatment, asserted through the rendered classes. */
  readonly muted: boolean;
  /** `stateNote(state, lens, counterpartyLabel)`. `null` ⇒ the indicators speak for the row. */
  readonly notes: Readonly<Record<'client' | 'expert', string | null>>;
  /** `stateLabel(state, lens)` — the status pill's text, lens-aware for the two no-shows. */
  readonly pill: Readonly<Record<'client' | 'expert', string>>;
  /** The `Badge` variant `TONE_VARIANT[STATE_PRESENTATION[state].tone]` resolves to. */
  readonly variant: string;
}

/** Both lenses share this note — spelled once so the table stays readable. */
function bothLenses(note: string | null): Readonly<Record<'client' | 'expert', string | null>> {
  return { client: note, expert: note };
}

/** Both lenses share this pill label — true for every state except the two no-shows. */
function bothPills(label: string): Readonly<Record<'client' | 'expert', string>> {
  return { client: label, expert: label };
}

const STATE_CASES: readonly StateCase[] = [
  {
    state: 'scheduled',
    muted: false,
    notes: bothLenses(null),
    pill: bothPills('Upcoming'),
    variant: 'outline',
  },
  {
    state: 'in_progress',
    muted: false,
    notes: bothLenses('Happening now'),
    pill: bothPills('Live now'),
    variant: 'default',
  },
  // `held` is the ONE state with no note: its indicators carry the row instead.
  {
    state: 'held',
    muted: false,
    notes: bothLenses(null),
    pill: bothPills('Held'),
    variant: 'success',
  },
  {
    state: 'no_show_client',
    muted: true,
    notes: {
      client: `${COUNTERPARTY} waited — billed at the minimum`,
      expert: "Client didn't join — settled at the minimum",
    },
    // The CLIENT never arrived: impersonal for the client, explicit for the expert.
    pill: { client: 'Not joined', expert: "Client didn't join" },
    variant: 'warning',
  },
  {
    state: 'missed_call',
    muted: true,
    notes: {
      client: `${COUNTERPARTY} wasn't able to join`,
      expert: "The call didn't start",
    },
    // The EXPERT never joined: impersonal for the expert, explicit for the client.
    pill: { client: "Expert didn't join", expert: "Didn't start" },
    variant: 'warning',
  },
  // Neither side joined: the same neutral words on both lenses, naming nobody, and the muted
  // tone — there is no absent party to flag.
  {
    state: 'nobody_joined',
    muted: true,
    notes: bothLenses('Neither side joined this call'),
    pill: bothPills('Nobody joined'),
    variant: 'secondary',
  },
  {
    state: 'cancelled',
    muted: true,
    notes: bothLenses('Cancelled — nothing charged'),
    // ⚠ NEUTRAL, NOT WARNING. Cancelling is a supported action used correctly; tinting it like
    // a failure would punish someone for using the feature as designed.
    pill: bothPills('Cancelled'),
    variant: 'secondary',
  },
  {
    state: 'outcome_pending',
    muted: true,
    notes: bothLenses('Outcome not recorded'),
    pill: bothPills('Not recorded'),
    variant: 'secondary',
  },
  // BAL-581 — Balo's own failure, never `warning`: there is no absent party to flag. Lens-
  // neutral, like `nobody_joined`.
  {
    state: 'venue_unavailable',
    muted: true,
    notes: bothLenses(VENUE_UNAVAILABLE_NOTE),
    pill: bothPills('Call room unavailable'),
    variant: 'secondary',
  },
  // Item 13 (BAL-411) — same icon/weight as `scheduled`; `stateNote` carries the one
  // distinguishing fact, and it is LENS-AWARE (the proposal card above the list is where
  // either side actually acts — this note only says WHY the badge differs from `scheduled`).
  {
    state: 'pending_reschedule',
    muted: false,
    notes: {
      client: `${COUNTERPARTY} suggested some new times — see above`,
      expert: 'Waiting on a reply to your suggested times',
    },
    pill: bothPills('New times proposed'),
    variant: 'info',
  },
];

const SWEEP = STATE_CASES.flatMap((stateCase) =>
  LENSES.map((lens) => ({
    ...stateCase,
    lens,
    expected: stateCase.notes[lens],
    expectedPill: stateCase.pill[lens],
  }))
);

describe('ConsultationList — relative days, on appointments only', () => {
  // Viewer zone is UTC under the suite's TZ, so the day keys below are unambiguous.
  const NOW = new Date('2026-06-11T12:00:00.000Z');

  beforeEach(() => {
    // `shouldAdvanceTime` keeps `waitFor` working — `LocalDateTime` upgrades in an effect.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says "Tomorrow at …" for an upcoming call on the next day', async () => {
    renderList([makeRow({ state: 'scheduled', scheduledStartIso: '2026-06-12T09:00:00.000Z' })]);
    expect(await screen.findByText(/Tomorrow at/)).toBeInTheDocument();
  });

  it('says "Today at …" for an upcoming call later the same day', async () => {
    renderList([makeRow({ state: 'scheduled', scheduledStartIso: '2026-06-11T22:00:00.000Z' })]);
    expect(await screen.findByText(/Today at/)).toBeInTheDocument();
  });

  it('falls back to an absolute date beyond tomorrow', async () => {
    renderList([makeRow({ state: 'scheduled', scheduledStartIso: '2026-06-14T09:00:00.000Z' })]);
    await waitFor(() => expect(firstTimeElement().textContent).toContain('14 Jun'));
    expect(firstTimeElement().textContent).not.toMatch(/Today|Tomorrow/);
  });

  /**
   * ⚠ THE RECORD KEEPS ITS DATE. `local-date-time.tsx` rules that a case never speaks in
   * relative time; the relative form is confined to rows a reader still has to act on. A past
   * call landing on today would otherwise read "Today at 10:00 am" where it should read the
   * date it will still read next week.
   */
  it.each([
    'held',
    'missed_call',
    'nobody_joined',
    'no_show_client',
    'venue_unavailable',
    'cancelled',
    'outcome_pending',
  ] as const)('never says Today/Tomorrow for the terminal %s row', async (state) => {
    renderList([makeRow({ state, scheduledStartIso: '2026-06-11T09:00:00.000Z' })]);
    await waitFor(() => expect(firstTimeElement().textContent).toContain('11 Jun'));
    expect(firstTimeElement().textContent).not.toMatch(/Today|Tomorrow/);
  });

  /** A terminal row shows no clock time either — the duration already carries the detail. */
  it('shows no clock time on a terminal row', async () => {
    renderList([makeRow({ state: 'held', scheduledStartIso: '2026-06-09T09:00:00.000Z' })]);
    await waitFor(() => expect(firstTimeElement().textContent).toContain('9 Jun'));
    expect(firstTimeElement().textContent).not.toMatch(/\d:\d{2}/);
  });
});

describe("ConsultationList — the status pill's three standing rules", () => {
  /**
   * ⚠ RULE 1 — THE TWO "DID NOT JOIN" STATES NEVER SHARE A LABEL ON THE SAME LENS.
   * `no_show_client` is THE CLIENT never arriving; `missed_call` is THE EXPERT never joining.
   * `stateNote`'s docblock calls who-was-absent "the single most load-bearing fact in the row",
   * so a pill that collapsed both to one "Not held" would tell the wronged party the call failed
   * without saying who — on the surface they opened to find out exactly that.
   */
  it.each(LENSES)('distinguishes no_show_client from missed_call on the %s lens', (lens) => {
    renderList([makeRow({ state: 'no_show_client' })], lens);
    const noShow = document.querySelector('[data-slot="badge"]')?.textContent?.trim();
    cleanup();

    renderList([makeRow({ state: 'missed_call' })], lens);
    const missed = document.querySelector('[data-slot="badge"]')?.textContent?.trim();

    expect(noShow).toBeTruthy();
    expect(missed).toBeTruthy();
    expect(noShow).not.toBe(missed);
  });

  /**
   * ⚠ RULE 2 — NO PILL ADDRESSES THE READER, AND NONE NAMES THEM AS THE ONE WHO FAILED.
   * `stateNote`'s `missed_call` arm is impersonal for the expert precisely so an expert reading
   * their OWN missed call is never told they failed. A "You didn't join" pill would put that
   * back. Swept across every state and both lenses so a future label cannot smuggle it in.
   */
  it.each(SWEEP)('uses no second person for $state on the $lens lens', ({ state, lens }) => {
    renderList([makeRow({ state })], lens);
    const label = document.querySelector('[data-slot="badge"]')?.textContent?.trim() ?? '';
    expect(label).not.toMatch(/\byou\b|\byour\b/i);
  });

  /**
   * ⚠ RULE 3 — `destructive` IS NEVER THE TONE. A consultation that did not happen is a fact
   * with a settlement story, not an error, and red on a surface both parties read about
   * themselves reads as blame. `warning` is the honest tone; `cancelled` is not even that,
   * because cancelling is a supported action used correctly.
   */
  it.each(SWEEP)('never renders $state as destructive on the $lens lens', ({ state, lens }) => {
    renderList([makeRow({ state })], lens);
    expect(document.querySelector('[data-slot="badge"]')).not.toHaveAttribute(
      'data-variant',
      'destructive'
    );
  });

  it('gives cancelled a neutral tone, never warning', () => {
    renderList([makeRow({ state: 'cancelled' })], 'client');
    expect(document.querySelector('[data-slot="badge"]')).toHaveAttribute(
      'data-variant',
      'secondary'
    );
  });

  it.each(LENSES)('gives nobody_joined a neutral tone, never warning, on the %s lens', (lens) => {
    renderList([makeRow({ state: 'nobody_joined' })], lens);
    const badge = document.querySelector('[data-slot="badge"]');
    expect(badge).toHaveAttribute('data-variant', 'secondary');
    expect(badge).not.toHaveAttribute('data-variant', 'warning');
  });
});

describe('ConsultationList — every state renders, on every lens', () => {
  it('sweeps all ten states across both lenses', () => {
    // A guard on the table itself: 10 states × 2 lenses. If a state is added to
    // `CaseConsultationStateLabel` without landing here, `STATE_PRESENTATION` would throw at
    // render time in production — this keeps the sweep honest about its own breadth.
    expect(SWEEP).toHaveLength(20);
    expect(new Set(STATE_CASES.map((c) => c.state)).size).toBe(10);
  });

  it.each(SWEEP)(
    'renders the $state state on the $lens lens',
    ({ state, muted, lens, expected, expectedPill, variant }) => {
      renderList([makeRow({ state })], lens);

      // The row itself rendered — one `li`, carrying the date as a real, machine-readable
      // `<time>` rather than a bare string.
      expect(rowElements()).toHaveLength(1);
      expect(firstTimeElement()).toHaveAttribute('datetime', '2026-06-12T09:00:00.000Z');
      expect(firstTimeElement().textContent).toContain('12 Jun');

      // The status pill: its TEXT (lens-aware for the two no-shows) and its TONE.
      const pill = document.querySelector('[data-slot="badge"]');
      expect(pill).not.toBeNull();
      expect(pill?.textContent?.trim()).toBe(expectedPill);
      expect(pill).toHaveAttribute('data-variant', variant);

      // The presentation half of `STATE_PRESENTATION` — muted states get the muted treatment
      // and NOT the primary one, so an all-primary or all-muted regression fails here.
      const badgeClass = firstStateBadge().className;
      expect(badgeClass).toContain(muted ? 'bg-muted' : 'bg-primary/10');
      expect(badgeClass).not.toContain(muted ? 'bg-primary/10' : 'bg-muted');

      // The note half — exactly the one this (state, lens) pair maps to, and nothing else.
      expect(renderedNotes()).toEqual(expected === null ? [] : [expected]);
    }
  );
});

describe('ConsultationList — no_show_client and missed_call are DIFFERENT events', () => {
  it.each(LENSES)('never gives them the same note on the %s lens', (lens) => {
    const { unmount } = renderList([makeRow({ state: 'no_show_client' })], lens);
    const [noShowNote] = renderedNotes();
    unmount();

    renderList([makeRow({ state: 'missed_call' })], lens);
    const [missedNote] = renderedNotes();

    if (noShowNote === undefined || missedNote === undefined) {
      throw new Error('both states must emit a note on both lenses');
    }
    expect(missedNote).not.toBe(noShowNote);
  });

  it('names the party that waited to the client, and settles it impersonally to the expert', () => {
    const { unmount } = renderList([makeRow({ state: 'no_show_client' })], 'client');
    expect(screen.getByText(`${COUNTERPARTY} waited — billed at the minimum`)).toBeInTheDocument();
    unmount();

    renderList([makeRow({ state: 'no_show_client' })], 'expert');
    expect(screen.getByText("Client didn't join — settled at the minimum")).toBeInTheDocument();
  });

  /**
   * ⚠ NON-SCOLDING AND MONEY-FREE. `missed_call` means THE EXPERT never joined, so the expert
   * arm is impersonal ("The call didn't start", never "you didn't join"), and NEITHER arm makes
   * a money claim — what a missed call settles to is the money block's to state, on the recap
   * and the receipt, never the row's.
   */
  it('keeps the missed-call copy blameless and money-free on both lenses', () => {
    const { unmount } = renderList([makeRow({ state: 'missed_call' })], 'client');
    expect(screen.getByText(`${COUNTERPARTY} wasn't able to join`)).toBeInTheDocument();
    expect(screen.queryByText(/charged|billed|minimum/i)).not.toBeInTheDocument();
    unmount();

    renderList([makeRow({ state: 'missed_call' })], 'expert');
    expect(screen.getByText("The call didn't start")).toBeInTheDocument();
    expect(screen.queryByText(/you didn't join|charged|billed|minimum/i)).not.toBeInTheDocument();
  });
});

describe('ConsultationList — nobody_joined names NOBODY', () => {
  /**
   * ⚠ NEITHER SIDE JOINED, SO THERE IS NO WRONGED PARTY AND NOBODY TO NAME. The whole row —
   * pill, note, link — must carry no counterparty, no party word, and no second person, on
   * BOTH lenses; the pill and note are asserted exactly so the sweep cannot pass on a blank row.
   */
  it.each(LENSES)('names neither party and never the reader on the %s lens', (lens) => {
    renderList([makeRow({ state: 'nobody_joined', durationMinutes: null })], lens);

    expect(document.querySelector('[data-slot="badge"]')?.textContent?.trim()).toBe(
      'Nobody joined'
    );
    expect(renderedNotes()).toEqual(['Neither side joined this call']);

    const text = firstRow().textContent ?? '';
    expect(text).toContain('Neither side joined this call');
    expect(text).not.toContain(COUNTERPARTY);
    expect(text).not.toMatch(/\bexpert\b|\bclient\b|\bconsultant\b/i);
    expect(text).not.toMatch(/\byou\b|\byour\b/i);
    expect(text).not.toMatch(/charged|billed|minimum/i);
  });

  it.each(LENSES)('never shares a pill or a note with missed_call on the %s lens', (lens) => {
    const { unmount } = renderList([makeRow({ state: 'missed_call' })], lens);
    const missedPill = document.querySelector('[data-slot="badge"]')?.textContent?.trim();
    const [missedNote] = renderedNotes();
    unmount();

    renderList([makeRow({ state: 'nobody_joined' })], lens);
    const nobodyPill = document.querySelector('[data-slot="badge"]')?.textContent?.trim();
    const [nobodyNote] = renderedNotes();

    if (missedNote === undefined || nobodyNote === undefined) {
      throw new Error('both states must emit a note on both lenses');
    }
    expect(missedPill).toBeTruthy();
    expect(nobodyPill).toBeTruthy();
    expect(nobodyPill).not.toBe(missedPill);
    expect(nobodyNote).not.toBe(missedNote);
  });
});

describe('ConsultationList — the recap link follows recapHref, NOT state', () => {
  it('renders NO link on a CANCELLED row — recapHrefOf never gives one a href', () => {
    renderList([makeRow({ state: 'cancelled', recapHref: null })]);
    expect(screen.queryByRole('link', { name: 'View recap' })).not.toBeInTheDocument();
  });

  it.each([
    'no_show_client',
    'missed_call',
    'nobody_joined',
    'venue_unavailable',
    'outcome_pending',
  ] as const)('links a %s row that has a recap href', (state) => {
    renderList([makeRow({ state, recapHref: '/meetings/m-4?from=case_surface' })]);
    expect(screen.getByRole('link', { name: 'View recap' })).toHaveAttribute(
      'href',
      '/meetings/m-4?from=case_surface'
    );
  });

  it('renders NO link on a HELD row with a null href — an absent action beats a dead one', () => {
    renderList([makeRow({ state: 'held', recapHref: null, hasTranscript: true, fileCount: 2 })]);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    // …but the indicators the held row DOES own are still there, so this is not a blank row.
    expect(screen.getByText('Transcript available')).toBeInTheDocument();
  });

  it('renders no link on a SCHEDULED row, which has no recap destination yet', () => {
    renderList([makeRow({ state: 'scheduled', recapHref: null })]);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('ConsultationList — the content indicators stay gated on `held`', () => {
  const LOADED = { hasTranscript: true, fileCount: 3, actionItemCount: 2 } as const;

  it.each([
    'scheduled',
    'in_progress',
    'no_show_client',
    'missed_call',
    'nobody_joined',
    'cancelled',
    'outcome_pending',
  ] as const)(
    'renders no transcript / file / action-item indicator for %s, even when set',
    (state) => {
      renderList([makeRow({ state, ...LOADED })]);
      expect(screen.queryByText('Transcript available')).not.toBeInTheDocument();
      expect(screen.queryByText('3 files')).not.toBeInTheDocument();
      expect(screen.queryByText('2 action items')).not.toBeInTheDocument();
    }
  );

  it('renders all three for a HELD row', () => {
    renderList([makeRow({ state: 'held', ...LOADED })]);
    expect(screen.getByText('Transcript available')).toBeInTheDocument();
    expect(screen.getByText('3 files')).toBeInTheDocument();
    expect(screen.getByText('2 action items')).toBeInTheDocument();
  });

  it('renders no indicators for a held row with nothing attached', () => {
    renderList([
      makeRow({ state: 'held', hasTranscript: false, fileCount: 0, actionItemCount: 0 }),
    ]);
    expect(screen.queryByText('Transcript available')).not.toBeInTheDocument();
    // ⚠ ANCHORED AT BOTH ENDS. An unanchored leading `\d+` is quadratic on a rejecting suffix
    // (SonarCloud S5852 / eslint `regexp/no-super-linear-move`), and the indicator's accessible
    // name is the WHOLE text node anyway, so the anchors cost nothing.
    expect(screen.queryByText(/^\d+ files?$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+ action items?$/)).not.toBeInTheDocument();
  });

  /**
   * ⚠ NO RECORDING INDICATOR EVER. `hasRecording` is hard-false platform-wide; rendering one
   * would promise an artefact that does not exist anywhere on the platform.
   */
  it('never renders a recording indicator, even when hasRecording is true', () => {
    renderList([makeRow({ state: 'held', hasRecording: true })]);
    expect(screen.queryByText(/recording/i)).not.toBeInTheDocument();
  });
});

describe('ConsultationList — counts, duration and the ordinal prefix', () => {
  it.each([
    [1, '1 file'],
    [2, '2 files'],
  ])('pluralises a fileCount of %i as "%s"', (fileCount, label) => {
    renderList([makeRow({ state: 'held', fileCount })]);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it.each([
    [1, '1 action item'],
    [4, '4 action items'],
  ])('pluralises an actionItemCount of %i as "%s"', (actionItemCount, label) => {
    renderList([makeRow({ state: 'held', actionItemCount })]);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('renders the wall-clock duration when present and nothing at all when null', () => {
    const { unmount } = renderList([makeRow({ durationMinutes: 45 })]);
    expect(screen.getByText('45 min')).toBeInTheDocument();
    unmount();

    // `null` ⇒ either stamp is missing. A "0 min" or an em-dash would both be claims.
    renderList([makeRow({ durationMinutes: null })]);
    expect(screen.queryByText(/\bmin\b/)).not.toBeInTheDocument();
  });

  it('renders a duration of 0 rather than treating it as absent', () => {
    renderList([makeRow({ durationMinutes: 0 })]);
    expect(screen.getByText('0 min')).toBeInTheDocument();
  });

  it('an UPCOMING row with no wall-clock duration yet shows the BOOKED length instead', () => {
    renderList([
      makeRow({
        state: 'scheduled',
        durationMinutes: null,
        scheduledMinutes: 30,
        recapHref: null,
        startedAtIso: null,
      }),
    ]);

    expect(screen.getByText('30 min')).toBeInTheDocument();
  });

  it('a CANCELLED row shows neither the wall-clock nor the booked length', () => {
    renderList([
      makeRow({ state: 'cancelled', durationMinutes: null, scheduledMinutes: 30, recapHref: null }),
    ]);

    expect(screen.queryByText(/\bmin\b/)).not.toBeInTheDocument();
  });

  it('prefixes the date with a screen-reader-only ordinal when there is one', () => {
    renderList([makeRow({ ordinal: 3 })]);
    expect(screen.getByText('Consultation 3:')).toBeInTheDocument();
  });

  it('renders no ordinal prefix when it is null (a cancelled row, or outside the set)', () => {
    renderList([makeRow({ ordinal: null, state: 'cancelled' })]);
    expect(screen.queryByText(/^Consultation \d+:/)).not.toBeInTheDocument();
    // The date is still there — the prefix is additive, not the label itself.
    expect(firstTimeElement().textContent).toContain('12 Jun');
  });
});

describe('ConsultationList — the recap click is tracked with the viewer lens', () => {
  it.each(LENSES)('fires case_action_clicked with lens "%s"', async (lens) => {
    const user = userEvent.setup();
    renderList([makeRow({ state: 'held' })], lens);

    await user.click(screen.getByRole('link', { name: 'View recap' }));

    expect(trackMock).toHaveBeenCalledWith(RECAP_EVENTS.CASE_ACTION_CLICKED, {
      action: 'view_recap',
      lens,
    });
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it('does not track anything on render alone', () => {
    renderList([makeRow({ state: 'held' })]);
    expect(trackMock).not.toHaveBeenCalled();
  });
});

describe('ConsultationList — the section head and the newest-last ordering', () => {
  const THREE: readonly CaseConsultationRowView[] = [
    makeRow({ meetingId: 'm-a', ordinal: 1, state: 'held' }),
    makeRow({ meetingId: 'm-b', ordinal: 2, state: 'cancelled', recapHref: null }),
    makeRow({ meetingId: 'm-c', ordinal: 3, state: 'scheduled', recapHref: null }),
  ];

  it('counts the rows in the head meta', () => {
    renderList(THREE);
    expect(screen.getByText('Consultations')).toBeInTheDocument();
    expect(screen.getByText('3 · newest last')).toBeInTheDocument();
  });

  it('renders a single row with a singular-looking count of 1', () => {
    renderList([makeRow()]);
    expect(screen.getByText('1 · newest last')).toBeInTheDocument();
  });

  /**
   * ⚠ THE COMPONENT NEVER SORTS. Ordering is applied SERVER-SIDE, so the rows must come out in
   * exactly the order handed in — a client-side re-sort would be a second place the ordering
   * rule lives.
   */
  it('renders one row per consultation, in the given order', () => {
    renderList(THREE);
    const ordinals = rowElements().map((row) => {
      const match = /Consultation (\d+):/.exec(row.textContent ?? '');
      return match?.[1] ?? null;
    });
    expect(ordinals).toEqual(['1', '2', '3']);
  });

  it('preserves a DELIBERATELY out-of-order list rather than re-sorting it', () => {
    renderList([
      makeRow({ meetingId: 'm-c', ordinal: 3 }),
      makeRow({ meetingId: 'm-a', ordinal: 1 }),
      makeRow({ meetingId: 'm-b', ordinal: 2 }),
    ]);
    const ordinals = rowElements().map((row) => {
      const match = /Consultation (\d+):/.exec(row.textContent ?? '');
      return match?.[1] ?? null;
    });
    expect(ordinals).toEqual(['3', '1', '2']);
  });

  it('drops the bottom border on the LAST row only', () => {
    renderList(THREE);
    const rows = rowElements();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.className.includes('border-b'))).toEqual([true, true, false]);
  });

  it('gives a lone row no bottom border — it is also the last row', () => {
    renderList([makeRow()]);
    const [only] = rowElements();
    if (only === undefined) throw new Error('no consultation row rendered');
    expect(only.className).not.toContain('border-b');
  });
});

describe('ConsultationList — the per-row kebab', () => {
  it('renders no trigger at all when every row flag is false (a colleague, or a held row)', () => {
    renderList([makeRow({ state: 'scheduled' })]);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('renders a trigger for an upcoming row with an actionable flag', () => {
    renderList([makeRow({ state: 'scheduled', canCancel: true })]);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('renders Reschedule + Cancel for a client-actionable scheduled row', async () => {
    const user = userEvent.setup();
    renderList([makeRow({ state: 'scheduled', canReschedule: true, canCancel: true })], 'client');
    await user.click(screen.getByRole('button'));
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['Reschedule', 'Cancel consultation']);
  });

  it('renders Propose a new time + Cancel for an expert-actionable scheduled row', async () => {
    const user = userEvent.setup();
    renderList(
      [makeRow({ state: 'scheduled', canProposeReschedule: true, canCancel: true })],
      'expert'
    );
    await user.click(screen.getByRole('button'));
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['Propose a new time', 'Cancel consultation']);
  });

  it('shows Cancel ONLY on a pending_reschedule row', async () => {
    const user = userEvent.setup();
    renderList([makeRow({ state: 'pending_reschedule', canCancel: true, canReschedule: false })]);
    await user.click(screen.getByRole('button'));
    const items = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toEqual(['Cancel consultation']);
  });

  // Pins that the row renders correctly given the shape the loader already produces inside
  // the join window (move flags refused, Cancel survives) — not re-deriving it here.
  it('shows Cancel only, no move item, for a row inside the join window (live), room ready', async () => {
    const user = userEvent.setup();
    renderList([
      makeRow({
        state: 'scheduled',
        live: true,
        roomReady: true,
        canCancel: true,
        canReschedule: false,
      }),
    ]);
    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('menuitem', { name: 'Cancel consultation' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Reschedule' })).not.toBeInTheDocument();
    expect(screen.getByText('Starting soon')).toBeInTheDocument();
  });

  it('shows "Starting soon" instead of "Upcoming" once inside the join window, room ready', () => {
    renderList([makeRow({ state: 'scheduled', live: true, roomReady: true })]);
    expect(screen.getByText('Starting soon')).toBeInTheDocument();
    expect(screen.queryByText('Upcoming')).not.toBeInTheDocument();
  });

  /** BAL-581 — a live row whose call room isn't ready yet never promises "Starting soon". */
  it('shows "Setting up call room" instead of "Starting soon" when live but the room is not ready', () => {
    renderList([makeRow({ state: 'scheduled', live: true, roomReady: false })]);
    expect(screen.getByText('Setting up call room')).toBeInTheDocument();
    expect(screen.queryByText('Starting soon')).not.toBeInTheDocument();
    expect(screen.queryByText('Upcoming')).not.toBeInTheDocument();
  });

  it('outside the join window still shows "Upcoming" regardless of roomReady', () => {
    renderList([makeRow({ state: 'scheduled', live: false, roomReady: false })]);
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.queryByText('Setting up call room')).not.toBeInTheDocument();
  });

  it('a colleague (no capability, every flag false) sees no trigger on any row', () => {
    renderList([
      makeRow({ meetingId: 'm-a', state: 'scheduled' }),
      makeRow({ meetingId: 'm-b', state: 'pending_reschedule' }),
    ]);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('calls onRowAction with the verb, the row, and the "menu" slot when a menu item fires', async () => {
    const user = userEvent.setup();
    const onRowAction = vi.fn();
    const row = makeRow({ state: 'scheduled', canCancel: true });
    renderList([row], 'client', onRowAction);
    await user.click(screen.getByRole('button'));
    await user.click(screen.getByRole('menuitem', { name: 'Cancel consultation' }));
    expect(onRowAction).toHaveBeenCalledWith('cancel', row, 'menu');
  });

  it('registers each row trigger keyed by its OWN meetingId and the "menu" slot', () => {
    const registerTrigger = vi.fn();
    renderList(
      [
        makeRow({ meetingId: 'm-a', state: 'scheduled', canCancel: true }),
        makeRow({ meetingId: 'm-b', state: 'scheduled', canCancel: true }),
      ],
      'client',
      vi.fn(),
      registerTrigger
    );
    expect(registerTrigger).toHaveBeenCalledWith('m-a', 'menu', expect.any(HTMLButtonElement));
    expect(registerTrigger).toHaveBeenCalledWith('m-b', 'menu', expect.any(HTMLButtonElement));
  });
});

describe('ConsultationList — the guest-count control (BAL-573)', () => {
  it('guestCount > 0 + canInvite ⇒ a button named "N guests … — manage", and clicking it calls onRowAction with the "guests" slot', async () => {
    const user = userEvent.setup();
    const onRowAction = vi.fn();
    const row = makeRow({ state: 'scheduled', guestCount: 2, canInvite: true });
    renderList([row], 'client', onRowAction);

    const button = screen.getByRole('button', { name: /2 guests .* — manage/ });
    await user.click(button);
    expect(onRowAction).toHaveBeenCalledWith('invite', row, 'guests');
  });

  it('guestCount > 0 + canInvite=false ⇒ the same text, but NOT a button', () => {
    renderList([makeRow({ state: 'scheduled', guestCount: 2, canInvite: false })]);
    expect(screen.getByText(/2 guests/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /guests/ })).not.toBeInTheDocument();
  });

  it('pluralises "1 guest" (singular)', () => {
    renderList([makeRow({ state: 'scheduled', guestCount: 1, canInvite: true })]);
    expect(screen.getByText(/^1 guest\b/)).toBeInTheDocument();
    expect(screen.queryByText(/1 guests/)).not.toBeInTheDocument();
  });

  it('renders nothing for guestCount: 0', () => {
    renderList([makeRow({ state: 'scheduled', guestCount: 0, canInvite: true })]);
    expect(screen.queryByText(/guest/i)).not.toBeInTheDocument();
  });

  it('AC 5 — the rendered row carries no "@" anywhere, for a row with guests', () => {
    renderList([makeRow({ state: 'scheduled', guestCount: 3, canInvite: true })]);
    expect(firstRow().textContent ?? '').not.toContain('@');
  });

  it('registers the guest-count control keyed by meetingId and the "guests" slot', () => {
    const registerTrigger = vi.fn();
    renderList(
      [makeRow({ meetingId: 'm-a', state: 'scheduled', guestCount: 2, canInvite: true })],
      'client',
      vi.fn(),
      registerTrigger
    );
    expect(registerTrigger).toHaveBeenCalledWith('m-a', 'guests', expect.any(HTMLButtonElement));
  });
});
