import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { track, RECAP_EVENTS } from '@/lib/analytics';
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
 *      two are asserted to differ from each other on the SAME lens.
 *   2. THE RECAP LINK FOLLOWS `recapHref`, NOT `state === 'held'`. `recapHrefOf` emits a href
 *      for `cancelled` and every terminal outcome, and the not-held recap panel is precisely
 *      where a no-show explains itself. A `cancelled` row with a href MUST link.
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
    ...overrides,
  };
}

function renderList(
  consultations: readonly CaseConsultationRowView[],
  lens: 'client' | 'expert' = 'client'
) {
  return render(
    <ConsultationList consultations={consultations} lens={lens} counterpartyLabel={COUNTERPARTY} />
  );
}

/**
 * Every note the component can emit, on either lens. Counting matches across this catalogue is
 * how "exactly one note" and "no note at all" become assertions that can genuinely fail — a
 * component that emitted a SECOND state's note alongside the right one would still satisfy a
 * bare `getByText`.
 */
const ALL_NOTES: readonly string[] = [
  'Upcoming · join link in your calendar',
  'Happening now',
  'Cancelled — nothing charged',
  `${COUNTERPARTY} waited — billed at the minimum`,
  "Client didn't join — settled at the minimum",
  `${COUNTERPARTY} wasn't able to join`,
  "The call didn't start",
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

// ── the 7 states × 2 lenses sweep ────────────────────────────────────────────────────────

interface StateCase {
  readonly state: CaseConsultationStateLabel;
  /** `STATE_PRESENTATION[state].muted` — the treatment, asserted through the rendered classes. */
  readonly muted: boolean;
  /** `stateNote(state, lens, counterpartyLabel)`. `null` ⇒ the indicators speak for the row. */
  readonly notes: Readonly<Record<'client' | 'expert', string | null>>;
}

/** Both lenses share this note — spelled once so the table stays readable. */
function bothLenses(note: string | null): Readonly<Record<'client' | 'expert', string | null>> {
  return { client: note, expert: note };
}

const STATE_CASES: readonly StateCase[] = [
  {
    state: 'scheduled',
    muted: false,
    notes: bothLenses('Upcoming · join link in your calendar'),
  },
  { state: 'in_progress', muted: false, notes: bothLenses('Happening now') },
  // `held` is the ONE state with no note: its indicators carry the row instead.
  { state: 'held', muted: false, notes: bothLenses(null) },
  {
    state: 'no_show_client',
    muted: true,
    notes: {
      client: `${COUNTERPARTY} waited — billed at the minimum`,
      expert: "Client didn't join — settled at the minimum",
    },
  },
  {
    state: 'missed_call',
    muted: true,
    notes: {
      client: `${COUNTERPARTY} wasn't able to join`,
      expert: "The call didn't start",
    },
  },
  { state: 'cancelled', muted: true, notes: bothLenses('Cancelled — nothing charged') },
  { state: 'outcome_pending', muted: true, notes: bothLenses('Outcome not recorded') },
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
  },
];

const SWEEP = STATE_CASES.flatMap((stateCase) =>
  LENSES.map((lens) => ({ ...stateCase, lens, expected: stateCase.notes[lens] }))
);

describe('ConsultationList — every state renders, on every lens', () => {
  it('sweeps all eight states across both lenses', () => {
    // A guard on the table itself: 8 states × 2 lenses. If a state is added to
    // `CaseConsultationStateLabel` without landing here, `STATE_PRESENTATION` would throw at
    // render time in production — this keeps the sweep honest about its own breadth.
    expect(SWEEP).toHaveLength(16);
    expect(new Set(STATE_CASES.map((c) => c.state)).size).toBe(8);
  });

  it.each(SWEEP)(
    'renders the $state state on the $lens lens',
    ({ state, muted, lens, expected }) => {
      renderList([makeRow({ state })], lens);

      // The row itself rendered — one `li`, carrying the date as a real, machine-readable
      // `<time>` rather than a bare string.
      expect(rowElements()).toHaveLength(1);
      expect(firstTimeElement()).toHaveAttribute('datetime', '2026-06-12T09:00:00.000Z');
      expect(firstTimeElement().textContent).toContain('12 Jun');

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
   * a money claim — no settlement path reads `missed_call` today, so "nothing was charged"
   * would assert an unverified fact.
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

describe('ConsultationList — the recap link follows recapHref, NOT state', () => {
  it('links a CANCELLED row that has a recap href — the not-held panel needs a route in', () => {
    renderList([makeRow({ state: 'cancelled', recapHref: '/meetings/m-9?from=case_surface' })]);
    expect(screen.getByRole('link', { name: 'View recap' })).toHaveAttribute(
      'href',
      '/meetings/m-9?from=case_surface'
    );
  });

  it.each(['no_show_client', 'missed_call', 'outcome_pending'] as const)(
    'links a %s row that has a recap href',
    (state) => {
      renderList([makeRow({ state, recapHref: '/meetings/m-4?from=case_surface' })]);
      expect(screen.getByRole('link', { name: 'View recap' })).toHaveAttribute(
        'href',
        '/meetings/m-4?from=case_surface'
      );
    }
  );

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
