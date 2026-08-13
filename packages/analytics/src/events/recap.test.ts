import { describe, it, expect } from 'vitest';
import { RECAP_EVENTS, RECAP_SERVER_EVENTS } from './recap';
import type {
  CaseSurfaceAction,
  CaseSurfaceState,
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
      'CTA_CLICKED',
      'FILE_DOWNLOADED',
      'TRANSCRIPT_OPENED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(RECAP_EVENTS.CASE_ACTION_CLICKED).toBe('case_action_clicked');
    expect(RECAP_EVENTS.CTA_CLICKED).toBe('recap_cta_clicked');
    expect(RECAP_EVENTS.FILE_DOWNLOADED).toBe('recap_file_downloaded');
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
};
const CASE_SURFACE_ACTIONS: Record<CaseSurfaceAction, true> = {
  book_another: true,
  mark_resolved: true,
  request_resolution: true,
  dismiss_resolution_request: true,
  view_recap: true,
  download_file: true,
};
const CASE_SURFACE_STATES: Record<CaseSurfaceState, true> = {
  open: true,
  resolved: true,
  auto_inactive: true,
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
    // `end_of_call` is still NOT declared: BAL-389 does not exist, so nothing writes it.
    expect(Object.keys(ENTRY_SOURCES).sort((a, b) => a.localeCompare(b))).toEqual([
      'case_surface',
      'direct',
      'notification',
    ]);
    expect(ENTRY_SOURCES).not.toHaveProperty('end_of_call');
  });

  it('declares only CASE-SURFACE ACTIONS the surface can actually emit', () => {
    // ⚠ NO `slot_quick_pick`. Owner decision D5 struck the next-available-slot strip the
    // design reference draws — there is no slot-listing endpoint anywhere on the platform —
    // so the surface renders a plain "Book another" affordance and nothing can emit a quick
    // pick. BAL-400 declares that value when it builds the producer.
    expect(Object.keys(CASE_SURFACE_ACTIONS).sort((a, b) => a.localeCompare(b))).toEqual([
      'book_another',
      'dismiss_resolution_request',
      'download_file',
      'mark_resolved',
      'request_resolution',
      'view_recap',
    ]);
    expect(CASE_SURFACE_ACTIONS).not.toHaveProperty('slot_quick_pick');
    // ⚠ NO `invite`: BAL-421 ships no invite affordance. `apps/web` has no seam that CREATES
    // a guest invite (only the `/join/[token]` landing that consumes one), and guest reads are
    // inert on `main` — so the button would promise access the grant cannot give.
    expect(CASE_SURFACE_ACTIONS).not.toHaveProperty('invite');
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

  it('ALIASES the shared context union rather than restating it', () => {
    // The assignment is the assertion: it only compiles while the two types are identical, so
    // a seventh `meeting_context_type` label reaches this event through `tsc`.
    const fromShared: MeetingContextTypeWithHolder = 'case';
    const asRecap: RecapContextType = fromShared;
    expect(asRecap).toBe('case');
    expect(Object.keys(CONTEXT_TYPES)).toHaveLength(6);
    expect(CONTEXT_TYPES).not.toHaveProperty('admin');
  });
});

describe('BAL-388 declares no event without a producer', () => {
  it('does not declare recap_recording_played (D-B — no recording; BAL-126 / BAL-140 own capture)', () => {
    const all: readonly string[] = [
      ...Object.values(RECAP_EVENTS),
      ...Object.values(RECAP_SERVER_EVENTS),
    ];
    expect(all).not.toContain('recap_recording_played');
  });

  it('does not declare recap_export (D-B — no export exists)', () => {
    const all: readonly string[] = [
      ...Object.values(RECAP_EVENTS),
      ...Object.values(RECAP_SERVER_EVENTS),
    ];
    expect(all).not.toContain('recap_export');
  });

  it('does not declare case_resolved_manually (BAL-421 — it would FORK case_resolved)', () => {
    // The case surface is a SECOND ENTRY POINT to the same close, distinguished by
    // `case_resolved.source`. A separate event name would split the source distribution
    // across two events at exactly the moment there were finally two sources to compare.
    const all: readonly string[] = [
      ...Object.values(RECAP_EVENTS),
      ...Object.values(RECAP_SERVER_EVENTS),
    ];
    expect(all).not.toContain('case_resolved_manually');
  });

  it('does not declare guest_converted_to_member (D-A — no guest lens; BAL-132 owns the guest arm)', () => {
    const all: readonly string[] = [
      ...Object.values(RECAP_EVENTS),
      ...Object.values(RECAP_SERVER_EVENTS),
    ];
    expect(all).not.toContain('guest_converted_to_member');
  });
});
