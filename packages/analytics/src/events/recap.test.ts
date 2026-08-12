import { describe, it, expect } from 'vitest';
import { RECAP_EVENTS, RECAP_SERVER_EVENTS } from './recap';
import type { RecapContextType, RecapEntrySource } from './recap';
import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';

// Values do NOT share one feature prefix (recap_* and case_*), so the guard uses the GENERIC
// snake_case matcher — anchored and with no nested quantifier (SonarCloud S5852).
const SNAKE_CASE = /^[a-z]+(_[a-z]+)*$/;

describe('RECAP_EVENTS (client)', () => {
  it('exposes exactly the BAL-388 recap client events', () => {
    // ⚠ THE COMPARATOR IS NOT OPTIONAL — a bare .sort() is a SonarCloud reliability bug
    // (implementation-defined comparator).
    expect(Object.keys(RECAP_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'CTA_CLICKED',
      'FILE_DOWNLOADED',
      'TRANSCRIPT_OPENED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
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
      'RECAP_VIEWED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(RECAP_SERVER_EVENTS.CASE_RESOLUTION_REQUEST_DISMISSED).toBe(
      'case_resolution_request_dismissed'
    );
    expect(RECAP_SERVER_EVENTS.CASE_RESOLVED).toBe('case_resolved');
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
const ENTRY_SOURCES: Record<RecapEntrySource, true> = { direct: true, notification: true };
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
    // `end_of_call` / `case_surface` are NOT declared: nothing writes `?from=` on a
    // /meetings/{id} URL from either surface (BAL-389 / BAL-421 own them).
    expect(Object.keys(ENTRY_SOURCES).sort((a, b) => a.localeCompare(b))).toEqual([
      'direct',
      'notification',
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

  it('does not declare guest_converted_to_member (D-A — no guest lens; BAL-132 owns the guest arm)', () => {
    const all: readonly string[] = [
      ...Object.values(RECAP_EVENTS),
      ...Object.values(RECAP_SERVER_EVENTS),
    ];
    expect(all).not.toContain('guest_converted_to_member');
  });
});
