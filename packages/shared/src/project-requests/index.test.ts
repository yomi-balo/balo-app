import { describe, it, expect } from 'vitest';
import {
  DECLINABLE_RELATIONSHIP_STATUSES,
  narrowToDeclinableRelationshipStatus,
  PROJECT_REQUEST_CLOSE_REASONS,
  BALO_CLOSE_REASONS,
  narrowToProjectRequestCloseReason,
  PROJECT_BRIEF_FAILURE_REASONS,
  narrowToProjectBriefFailureReason,
  MAX_PARSE_INPUT_BYTES,
  PARSE_DEADLINE_MS,
} from './index';

/**
 * BAL-540 — direct unit coverage for the shared request-lifecycle vocabulary. Consumers
 * (apps/web actions, apps/api templates, packages/db invariants) exercise these functions
 * too, but v8 coverage does not attribute a cross-package consumer's execution back to this
 * file's own report — so this package needs its own test for the file to show covered at all
 * (memory: `reference_shared_pkg_coverage_understated_in_isolation`).
 */

describe('narrowToDeclinableRelationshipStatus', () => {
  it.each(DECLINABLE_RELATIONSHIP_STATUSES)('accepts %s', (status) => {
    expect(narrowToDeclinableRelationshipStatus(status)).toBe(status);
  });

  it('returns null for accepted (refused by the transition guard)', () => {
    expect(narrowToDeclinableRelationshipStatus('accepted')).toBeNull();
  });

  it('returns null for declined (already terminal)', () => {
    expect(narrowToDeclinableRelationshipStatus('declined')).toBeNull();
  });

  it('returns null for an unrecognised string', () => {
    expect(narrowToDeclinableRelationshipStatus('not_a_real_status')).toBeNull();
  });
});

describe('narrowToProjectRequestCloseReason', () => {
  it.each(PROJECT_REQUEST_CLOSE_REASONS)('accepts %s', (reason) => {
    expect(narrowToProjectRequestCloseReason(reason)).toBe(reason);
  });

  it('returns null for a non-string value', () => {
    expect(narrowToProjectRequestCloseReason(undefined)).toBeNull();
    expect(narrowToProjectRequestCloseReason(null)).toBeNull();
    expect(narrowToProjectRequestCloseReason(42)).toBeNull();
    expect(narrowToProjectRequestCloseReason({})).toBeNull();
  });

  it('returns null for an unrecognised string', () => {
    expect(narrowToProjectRequestCloseReason('not_a_real_reason')).toBeNull();
  });
});

describe('BALO_CLOSE_REASONS', () => {
  it('is exactly the close reasons minus the client-only withdrawn', () => {
    expect([...BALO_CLOSE_REASONS].sort()).toStrictEqual(
      PROJECT_REQUEST_CLOSE_REASONS.filter((r) => r !== 'withdrawn')
        .slice()
        .sort()
    );
  });

  it('never includes withdrawn', () => {
    expect(BALO_CLOSE_REASONS).not.toContain('withdrawn');
  });
});

describe('narrowToProjectBriefFailureReason (BAL-254)', () => {
  it.each(PROJECT_BRIEF_FAILURE_REASONS)('accepts %s', (reason) => {
    expect(narrowToProjectBriefFailureReason(reason)).toBe(reason);
  });

  it('returns null for a non-string value', () => {
    expect(narrowToProjectBriefFailureReason(undefined)).toBeNull();
    expect(narrowToProjectBriefFailureReason(null)).toBeNull();
    expect(narrowToProjectBriefFailureReason(42)).toBeNull();
    expect(narrowToProjectBriefFailureReason({})).toBeNull();
  });

  /**
   * `project_brief_parses.failure_reason` is `text`, not a pgEnum (D3), so a row written by an
   * older deploy really can hold a string outside the tuple. It must degrade to the generic
   * banner, not throw on a display path.
   */
  it('returns null for an unrecognised string', () => {
    expect(narrowToProjectBriefFailureReason('anthropic_overloaded_529')).toBeNull();
  });
});

describe('brief-parse caps (BAL-254)', () => {
  /**
   * ⚠ THE DEADLINE MUST EXCEED THE CLIENT'S 2-MINUTE POLL CAP. `timed_out` is DERIVED at read
   * from `created_at`; if the derivation fired first the panel would show "timed out" for a
   * parse it was still actively polling.
   */
  it('PARSE_DEADLINE_MS is longer than the 2-minute client poll window', () => {
    expect(PARSE_DEADLINE_MS).toBeGreaterThan(2 * 60 * 1000);
  });

  it('MAX_PARSE_INPUT_BYTES is 10 MiB', () => {
    expect(MAX_PARSE_INPUT_BYTES).toBe(10 * 1024 * 1024);
  });
});
