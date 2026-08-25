import { describe, expect, it } from 'vitest';
import { BOOKABLE_CONTEXT_TYPES } from '@balo/shared/meetings';
import {
  CALENDAR_CONTEXT_REGISTRY,
  CALENDAR_SUBJECT_SOURCES,
} from './calendar-context-registry.js';

/**
 * BAL-433 Slice 1 — THE REGISTRY AS DATA.
 *
 * ⚠⚠ THE EXHAUSTIVENESS GUARANTEE IS THE `Record`, AND IT IS COMPILE-TIME — a sixth bookable
 * label fails `pnpm --filter api typecheck` on a missing key and a stray label fails on an
 * extra one. THIS FILE IS ITS RUNTIME COMPANION, AND IT IS NOT REDUNDANT: a key type that
 * accidentally resolved to `never` (a renamed label dropping out of the `Extract`) would let
 * `{}` satisfy that `Record` and the whole compile-time guarantee would pass VACUOUSLY. The
 * key-set assertion below is what refuses that.
 */
describe('CALENDAR_CONTEXT_REGISTRY — the key set (the non-vacuity guard)', () => {
  it('covers EXACTLY the five bookable context types, both directions', () => {
    expect(Object.keys(CALENDAR_CONTEXT_REGISTRY).sort()).toEqual(
      [...BOOKABLE_CONTEXT_TYPES].sort()
    );
  });

  it('has a descriptor for every bookable label — no label reaches no calendar', () => {
    for (const contextType of BOOKABLE_CONTEXT_TYPES) {
      const descriptor = CALENDAR_CONTEXT_REGISTRY[contextType];
      expect(descriptor, `${contextType} resolves to no descriptor`).toBeDefined();
    }
  });

  /**
   * ⚠ THE FLOOR IS THE POINT. An empty or one-entry registry would satisfy every "for each
   * key…" assertion above for the wrong reason. Five is the arity BAL-433 settled on: 7 = the
   * pgEnum, 6 = holder-bearing, 5 = bookable = THIS, 4 = web engagement-authz.
   */
  it('is five entries — the bookable arity, not the pgEnum arity', () => {
    expect(Object.keys(CALENDAR_CONTEXT_REGISTRY)).toHaveLength(5);
    expect(BOOKABLE_CONTEXT_TYPES).toHaveLength(5);
  });

  it('excludes the two non-bookable labels BY ABSENCE — `admin` and `retainer_checkin`', () => {
    // Both are excluded by TYPE, never by a runtime branch: `admin` has no owning party at all
    // (`context_id IS NULL` by CHECK) and `retainer_checkin` has no booking producer. Asserted
    // here so "the registry is total over the SEVEN labels" cannot be read into it.
    expect(CALENDAR_CONTEXT_REGISTRY).not.toHaveProperty('admin');
    expect(CALENDAR_CONTEXT_REGISTRY).not.toHaveProperty('retainer_checkin');
  });
});

describe('CALENDAR_CONTEXT_REGISTRY — the descriptors', () => {
  it('carries the five headline nouns verbatim', () => {
    // Pinned as VALUES, not as a shape: these strings land on an expert's own calendar and
    // share their vocabulary with `load-recap.ts`'s FALLBACK_TITLE map, so a silent edit here
    // would split the two surfaces apart.
    expect(CALENDAR_CONTEXT_REGISTRY.case.eventLabel).toBe('Consultation');
    expect(CALENDAR_CONTEXT_REGISTRY.project_kickoff.eventLabel).toBe('Project kickoff');
    expect(CALENDAR_CONTEXT_REGISTRY.package_session.eventLabel).toBe('Package session');
    expect(CALENDAR_CONTEXT_REGISTRY.project_discovery.eventLabel).toBe('Discovery call');
    expect(CALENDAR_CONTEXT_REGISTRY.request_interaction.eventLabel).toBe('Intro call');
  });

  it('resolves the three title-less contexts to their own LABEL as the subject', () => {
    // BAL-433 D3 — no title column exists on `engagements` or on any delivery subtype, and
    // synthesising one from a proposal is a title CONCEPT no ticket has designed. A neutral
    // subject beats a confidently wrong one on an expert's calendar.
    expect(CALENDAR_CONTEXT_REGISTRY.project_kickoff.subjectSource).toBe('label');
    expect(CALENDAR_CONTEXT_REGISTRY.package_session.subjectSource).toBe('label');
  });

  it('reads the two title-bearing shapes from their own tables', () => {
    expect(CALENDAR_CONTEXT_REGISTRY.case.subjectSource).toBe('case_title');
    expect(CALENDAR_CONTEXT_REGISTRY.project_discovery.subjectSource).toBe('request_title');
    expect(CALENDAR_CONTEXT_REGISTRY.request_interaction.subjectSource).toBe('request_title');
  });

  it('⚠ every subjectSource is one of the THREE closed kinds — a fourth is a decision', () => {
    for (const [contextType, descriptor] of Object.entries(CALENDAR_CONTEXT_REGISTRY)) {
      expect(CALENDAR_SUBJECT_SOURCES, `${contextType} names an unknown subject source`).toContain(
        descriptor.subjectSource
      );
    }
    expect([...CALENDAR_SUBJECT_SOURCES].sort()).toEqual(['case_title', 'label', 'request_title']);
  });

  /**
   * ⚠ ADR-1044 §4 / BAL-433 Ruling 2 — NO COUNTERPARTY ADDRESS EVER REACHES A CALENDAR WRITE.
   * The registry is the one piece of DATA the vendor payload's headline is built from, so it
   * is checked here as well as by `no-counterparty-address-on-calendar-writes.test.ts` (which
   * reads this same table as its Layer 1).
   */
  it('⚠ no eventLabel is blank or contains an address token', () => {
    for (const [contextType, descriptor] of Object.entries(CALENDAR_CONTEXT_REGISTRY)) {
      expect(
        descriptor.eventLabel.trim().length,
        `${contextType} has a blank label`
      ).toBeGreaterThan(0);
      for (const token of ['@', 'mailto', '.com']) {
        expect(descriptor.eventLabel, `${contextType}'s label contains "${token}"`).not.toContain(
          token
        );
      }
    }
  });
});
