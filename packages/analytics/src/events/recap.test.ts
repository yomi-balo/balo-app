import { describe, it, expect } from 'vitest';
import {
  CASES_INDEX_CARD_STATES,
  CASES_INDEX_TARGETS,
  RECAP_EVENTS,
  RECAP_SERVER_EVENTS,
} from './recap';
import type {
  CaseResolveSource,
  CaseSurfaceAction,
  CaseSurfaceState,
  CasesIndexWorkspaceType,
  RecapContextType,
  RecapEntrySource,
} from './recap';
import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';

// Values do NOT share one feature prefix (recap_* and case_*), so the guard uses the GENERIC
// snake_case matcher — anchored and with no nested quantifier (SonarCloud S5852).
const SNAKE_CASE = /^[a-z]+(_[a-z]+)*$/;

describe('RECAP_EVENTS (client)', () => {
  it('exposes exactly the BAL-388 recap client events', () => {
    // ⚠ THE COMPARATOR IS NOT OPTIONAL — a bare .sort() is a SonarCloud reliability bug
    // (implementation-defined comparator).
    expect(Object.keys(RECAP_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'CASE_ACTION_CLICKED',
      'CASES_INDEX_CLICKED',
      'CASES_INDEX_RESOLVED_TOGGLED',
      'CASES_INDEX_VIEWED',
      'CTA_CLICKED',
      'FILE_DOWNLOADED',
      'RECORDING_PLAYED',
      'TRANSCRIPT_OPENED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(RECAP_EVENTS.CASE_ACTION_CLICKED).toBe('case_action_clicked');
    expect(RECAP_EVENTS.CASES_INDEX_CLICKED).toBe('cases_index_clicked');
    expect(RECAP_EVENTS.CASES_INDEX_RESOLVED_TOGGLED).toBe('cases_index_resolved_toggled');
    expect(RECAP_EVENTS.CASES_INDEX_VIEWED).toBe('cases_index_viewed');
    expect(RECAP_EVENTS.CTA_CLICKED).toBe('recap_cta_clicked');
    expect(RECAP_EVENTS.FILE_DOWNLOADED).toBe('recap_file_downloaded');
    expect(RECAP_EVENTS.RECORDING_PLAYED).toBe('recap_recording_played');
    expect(RECAP_EVENTS.TRANSCRIPT_OPENED).toBe('recap_transcript_opened');
  });

  it('uses snake_case event values', () => {
    for (const value of Object.values(RECAP_EVENTS)) {
      expect(value).toMatch(SNAKE_CASE);
    }
  });
});

describe('RECAP_SERVER_EVENTS (server)', () => {
  it('exposes exactly the BAL-388 recap server events', () => {
    expect(Object.keys(RECAP_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'CASE_RESOLUTION_REQUEST_DISMISSED',
      'CASE_RESOLVED',
      'CASE_SURFACE_VIEWED',
      'RECAP_VIEWED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(RECAP_SERVER_EVENTS.CASE_RESOLUTION_REQUEST_DISMISSED).toBe(
      'case_resolution_request_dismissed'
    );
    expect(RECAP_SERVER_EVENTS.CASE_RESOLVED).toBe('case_resolved');
    expect(RECAP_SERVER_EVENTS.CASE_SURFACE_VIEWED).toBe('case_surface_viewed');
    expect(RECAP_SERVER_EVENTS.RECAP_VIEWED).toBe('recap_viewed');
  });

  it('uses snake_case event values', () => {
    for (const value of Object.values(RECAP_SERVER_EVENTS)) {
      expect(value).toMatch(SNAKE_CASE);
    }
  });
});

/**
 * Compile-time exhaustive maps. A member added to either union WITHOUT updating these fails
 * `tsc` (missing key), and the runtime assertions below fail too — which is what makes the
 * no-producer rule bind to enum VALUES and not just to event names.
 */
const ENTRY_SOURCES: Record<RecapEntrySource, true> = {
  direct: true,
  notification: true,
  case_surface: true,
  end_of_call: true,
};
const CASE_SURFACE_ACTIONS: Record<CaseSurfaceAction, true> = {
  book_another: true,
  mark_resolved: true,
  request_resolution: true,
  dismiss_resolution_request: true,
  view_recap: true,
  download_file: true,
  view_file: true,
  join: true,
  invite: true,
};
const CASES_INDEX_WORKSPACE_TYPES: Record<CasesIndexWorkspaceType, true> = {
  company: true,
  expert: true,
};
const CASE_SURFACE_STATES: Record<CaseSurfaceState, true> = {
  open: true,
  resolved: true,
  auto_inactive: true,
};
const CASE_RESOLVE_SOURCES: Record<CaseResolveSource, true> = {
  recap: true,
  end_of_call: true,
  case_surface: true,
  sweep: true,
};
const CONTEXT_TYPES: Record<RecapContextType, true> = {
  case: true,
  project_discovery: true,
  project_kickoff: true,
  package_session: true,
  retainer_checkin: true,
  request_interaction: true,
};

describe('BAL-388 enum values', () => {
  it('declares only ENTRY SOURCES a producer writes today', () => {
    // `case_surface` IS declared as of BAL-421 — the ticket that emits it. Its producer is
    // `map-case-consultations.ts`, whose `recapHref` is `/meetings/{id}?from=case_surface`.
    // `end_of_call` IS declared as of BAL-389 — the end-of-call screen's ready-state CTA links
    // to `/meetings/{id}?from=end_of_call` AND `resolveEntrySource` was widened in the same
    // ticket to whitelist it. Both surfaces exist; each value arrived with its producer.
    expect(Object.keys(ENTRY_SOURCES).sort((a, b) => a.localeCompare(b))).toEqual([
      'case_surface',
      'direct',
      'end_of_call',
      'notification',
    ]);
  });

  it('declares only CASE-SURFACE ACTIONS the surface can actually emit', () => {
    // ⚠ NO `slot_quick_pick`. Owner decision D5 struck the next-available-slot strip the
    // design reference draws — there is no slot-listing endpoint anywhere on the platform —
    // so the surface renders a plain "Book another" affordance and nothing can emit a quick
    // pick. BAL-400 declares that value when it builds the producer.
    // ⚠ `join` IS declared as of BAL-567 — the ticket that BUILDS its producer. Before it, the
    // case surface had no Join affordance at all (`case-nudge.tsx` carried a docblock saying so),
    // because the only member join route was the anonymous lobby. The value arrived with the
    // button, which is the rule.
    // ⚠ `view_file` IS DISTINCT FROM `download_file`, not a rename: an image OPENS in the
    // in-app viewer while every other type downloads, and one value spanning both would make
    // the download figure an "interacted with a file" figure.
    // ⚠ `invite` IS declared as of BAL-573 — the ticket that BUILDS its producer. See the
    // module docblock's `invite` note for why the two reasons BAL-421 withheld it no longer
    // hold.
    expect(Object.keys(CASE_SURFACE_ACTIONS).sort((a, b) => a.localeCompare(b))).toEqual([
      'book_another',
      'dismiss_resolution_request',
      'download_file',
      'invite',
      'join',
      'mark_resolved',
      'request_resolution',
      'view_file',
      'view_recap',
    ]);
    expect(CASE_SURFACE_ACTIONS).not.toHaveProperty('slot_quick_pick');
  });

  it('keeps the two CLOSED case states distinct', () => {
    // Collapsing `resolved` and `auto_inactive` into one `closed` would hide whether cases
    // are being deliberately resolved or merely going quiet — the most useful thing this
    // dimension can report.
    expect(Object.keys(CASE_SURFACE_STATES).sort((a, b) => a.localeCompare(b))).toEqual([
      'auto_inactive',
      'open',
      'resolved',
    ]);
  });

  it('declares only CASE RESOLVE SOURCES with a live closing surface', () => {
    // ONE business fact, ONE event name (`case_resolved`), ONE widening union. BAL-389's
    // end-of-call screen and BAL-421's case surface are the second and third ENTRY POINTS to
    // the same close; BAL-572's `case-inactivity-sweep` is the fourth, and the only
    // server-published one — never separate events.
    expect(Object.keys(CASE_RESOLVE_SOURCES).sort((a, b) => a.localeCompare(b))).toEqual([
      'case_surface',
      'end_of_call',
      'recap',
      'sweep',
    ]);
  });

  it('ALIASES the shared context union rather than restating it', () => {
    // The assignment is the assertion: it only compiles while the two types are identical, so
    // a seventh `meeting_context_type` label reaches this event through `tsc`.
    // ⚠ NO `expect(asRecap).toBe('case')` HERE — it can never fail (the value was just
    // assigned from a literal), so it reads as coverage while asserting nothing. The
    // COMPILE-TIME assignment above is the real guard; the runtime assertions below are the
    // ones that can actually go red.
    const fromShared: MeetingContextTypeWithHolder = 'case';
    const asRecap: RecapContextType = fromShared;
    expect(CONTEXT_TYPES).toHaveProperty(asRecap);
    expect(Object.keys(CONTEXT_TYPES)).toHaveLength(6);
    expect(CONTEXT_TYPES).not.toHaveProperty('admin');
  });
});

describe('BAL-567 — the /cases index vocabularies', () => {
  it('pins CASES_INDEX_TARGETS as an exact ORDERED tuple', () => {
    // ⚠ ORDERED, not sorted, and with a LENGTH assertion beside it. The tuple IS the type
    // (`CasesIndexTarget` is derived from it), so a value added here without a producer, or a
    // producer added without its value, is exactly what this pin catches. A membership
    // assertion with no length assertion goes vacuous the moment a member is added.
    expect([...CASES_INDEX_TARGETS]).toEqual([
      'case',
      'join',
      'choose_time',
      'review',
      'book_another',
      'book_time',
      'book_again',
      'book',
    ]);
    expect(CASES_INDEX_TARGETS).toHaveLength(8);
    // ⚠ NO act affordance on the index. Every button opens the case; nothing on this surface
    // cancels, reschedules, resolves or answers a proposal, because doing so would need a
    // per-row capability resolution the index deliberately never performs.
    expect(CASES_INDEX_TARGETS).not.toContain('cancel');
    expect(CASES_INDEX_TARGETS).not.toContain('mark_resolved');
  });

  it('pins CASES_INDEX_CARD_STATES as an exact ORDERED tuple of eight', () => {
    expect([...CASES_INDEX_CARD_STATES]).toEqual([
      'live',
      'booked',
      'proposal',
      'proposal_pending',
      'resolution_ask',
      'resolution_ask_pending',
      'nothing_booked',
      'no_calls',
    ]);
    expect(CASES_INDEX_CARD_STATES).toHaveLength(8);
  });

  it('declares exactly the two workspaces the index can render for', () => {
    // ⚠ NOT a lens and NOT `activeMode` — it names WHICH LIST rendered, never an
    // authorization input. `agency` is absent on purpose: an agency colleague reads the expert
    // list, they do not get a third one.
    expect(Object.keys(CASES_INDEX_WORKSPACE_TYPES).sort((a, b) => a.localeCompare(b))).toEqual([
      'company',
      'expert',
    ]);
    expect(Object.keys(CASES_INDEX_WORKSPACE_TYPES)).toHaveLength(2);
    expect(CASES_INDEX_WORKSPACE_TYPES).not.toHaveProperty('agency');
  });
});

describe('BAL-388 declares no event without a producer', () => {
  /**
   * One table, one assertion — these four cases differed only in the string, so four copies
   * of the same body added no coverage and one more would have been a fifth copy. The `why`
   * column is the part worth keeping: it records WHY each name must stay undeclared, which is
   * the thing a future reader is tempted to undo.
   */
  const UNDECLARED: readonly { readonly event: string; readonly why: string }[] = [
    { event: 'recap_export', why: 'D-B — no export exists' },
    {
      event: 'case_resolved_manually',
      why: 'BAL-421 — it would FORK `case_resolved`. The case surface is a SECOND ENTRY POINT to the same close, distinguished by `case_resolved.source`; a separate event name would split the source distribution across two events at exactly the moment there were finally two sources to compare.',
    },
    {
      event: 'guest_converted_to_member',
      why: 'D-A — not a recap event: still no guest lens (R5 — BAL-439 opened the recap to a guest via a SIBLING gate and view-model, never a fourth RecapLens value). It IS declared — in events/guest.ts, where BAL-489 landed it WITH its producer (the guest→member linkage at new-user creation) — so this pin only keeps it out of the RECAP_* families',
    },
  ];

  it.each(UNDECLARED)('does not declare $event ($why)', ({ event }) => {
    const all: readonly string[] = [
      ...Object.values(RECAP_EVENTS),
      ...Object.values(RECAP_SERVER_EVENTS),
    ];
    expect(all).not.toContain(event);
  });
});
