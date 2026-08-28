import { describe, expect, it } from 'vitest';
import type { MeetingContextTypeLabel } from '@balo/shared/meetings';
import { guestContextLabel } from './guest-context-label';

/** Mirrors `MEETING_CONTEXT_PRECEDENCE`'s key set — the total-by-construction proof. */
const ALL_CONTEXT_TYPES: readonly MeetingContextTypeLabel[] = [
  'case',
  'project_kickoff',
  'package_session',
  'retainer_checkin',
  'request_interaction',
  'project_discovery',
  'admin',
];

describe('guestContextLabel', () => {
  it('is TOTAL — every MeetingContextTypeLabel resolves to a non-empty string', () => {
    for (const contextType of ALL_CONTEXT_TYPES) {
      expect(guestContextLabel(contextType).length).toBeGreaterThan(0);
    }
  });

  it('maps a resolved context to its human label', () => {
    expect(guestContextLabel('case')).toBe('Consultation');
    expect(guestContextLabel('project_discovery')).toBe('Discovery call');
    expect(guestContextLabel('request_interaction')).toBe('Intro call');
  });

  it('⚠ `null` resolves to the GENERIC label — the caller`s way of saying "no primary context"', () => {
    expect(guestContextLabel(null)).toBe('Meeting');
  });

  it('⚠ `admin` ALSO resolves to the generic label — unreachable through selectPrimaryMeetingContext, listed anyway to keep the record total', () => {
    expect(guestContextLabel('admin')).toBe('Meeting');
  });
});
