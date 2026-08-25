import { describe, it, expect } from 'vitest';
import { BOOKABLE_CONTEXT_TYPES } from '@balo/shared/meetings';
import {
  CALENDAR_CONTEXT_REGISTRY,
  CALENDAR_SUBJECT_SOURCES,
} from '../services/consultation-events/calendar-context-registry.js';
import { buildConsultationEvent } from '../services/consultation-events/event-mapper.js';
import { ALL_SOURCE_FILES, isUnderAny, markersInCode, readRaw } from './_source-scan.js';

/**
 * BAL-433 / ADR-1044 §4 (Ruling 2) — **NO COUNTERPARTY ADDRESS EVER REACHES A CALENDAR WRITE.**
 *
 * The ruling this file guards:
 *
 * > Balo never puts an attendee on a provider-written calendar event. The expert's event names
 * > the client COMPANY and carries Balo's own member join route; it invites nobody, and it
 * > carries no address for anyone on the other side of the engagement.
 *
 * ⚠⚠ WHY IT IS A STRUCTURAL INVARIANT AND NOT THREE UNIT ASSERTIONS. An attendee on an event
 * Balo writes THROUGH the vendor makes the PROVIDER send an invitation email FROM THE EXPERT'S
 * OWN MAILBOX — Balo would have caused an unbranded, un-suppressible message it never composed,
 * disclosing one party's address to the other, outside every notification rule the platform
 * owns. That is a product decision, not a bug, which is why the failure message below says so.
 *
 * ⚠⚠ THE BAR THIS FILE IS WRITTEN TO: IT MUST FAIL WHEN SOMEONE WRITES THE CODE, NOT MERELY
 * WHEN SOMEONE EDITS A FIXTURE. Three unit tests already assert `event.attendees` is
 * `undefined` (`event-mapper.test.ts`, `project-booking-to-calendar.test.ts`,
 * `update-consultation-event.test.ts`). That form is WEAKER THAN IT LOOKS: it catches exactly
 * one field name and stays green for `organizer`, `guests`, `emails`, `invitees`, or anything
 * else a future edit adds. So there are three layers, and only one of them reads the registry:
 *
 *   · Layer 1 (DATA)   — the registry, which is the only DATA the headline is built from,
 *                        names no address and no title source outside a closed three.
 *   · Layer 2 (RULE)   — the vendor payload's KEY SET is closed and pinned EXACTLY, so a new
 *                        key of ANY name fails, not merely `attendees`.
 *   · Layer 3 (SOURCE) — nobody has WRITTEN the vocabulary anywhere under a calendar-write
 *                        directory (`CALENDAR_WRITE_DIRS`, a LIST so BAL-475's ICS builder adds
 *                        a root instead of escaping the ban), and nobody names the vendor's
 *                        attendee TYPE anywhere in `apps/api/src`.
 *
 * ⚠⚠ BOTH LAYER-3 SCANS DERIVE THEIR SUBJECTS FROM A DIRECTORY WALK; NEITHER PINS A FILE LIST.
 * A pinned subject list was EMPIRICALLY DEFEATED during BAL-447's review — a fresh
 * `services/calendar/<name>.ts` passed every assertion by simply not being listed — and new
 * files are precisely the risk here, since BAL-433 itself added three modules to the scanned
 * directory. Deriving from the walk closes that BY CONSTRUCTION: a fourth module lands in the
 * subject set the moment it exists.
 *
 * ⚠ NO REGEX ANYWHERE (SonarCloud S5852 / `regexp/no-super-linear-move`). The reading
 * primitives live in `./_source-scan.ts`; see its docblock for the comment-classifier and
 * `import.meta.url` reasoning.
 *
 * IF THIS TEST FAILS, THE REMEDY IS A DECISION, NOT A TEST EDIT: amend ADR-1044 first.
 */

const REMEDY =
  'ADR-1044 §4: an attendee on a provider-written event makes the PROVIDER email from the ' +
  "expert's own mailbox. If this test fails, the remedy is a decision — amend ADR-1044 first.";

/** The address vocabulary, in the casings a real edit would use. */
const ADDRESS_MARKERS = [
  'attendees',
  'attendee',
  'Attendee',
  'ATTENDEE',
  'mailto',
  'email',
  'Email',
  'EMAIL',
] as const;

/** The directory that owns every vendor calendar write today. */
const CONSULTATION_EVENTS_DIR = 'services/consultation-events/';

/**
 * EVERY calendar-artefact root Scan A covers — A LIST, WITH ONE ENTRY TODAY, DELIBERATELY.
 *
 * ⚠ THE SHAPE IS THE POINT. Scan A's auto-enrolment property (a new module lands in the subject
 * set the moment it exists) holds WITHIN a root, not across the app: a calendar artefact written
 * somewhere else — say `services/ics/build-invite.ts` — would name `email` or `mailto` freely and
 * this suite would stay green. BAL-475 (ICS delivery) is DEFINITIONALLY the module that needs an
 * address (it must send an invite to someone), so the boundary between "the recipient's own
 * address" and "the counterparty's address" (the ADR-1044 §3 ban) is exactly what it will have to
 * argue. Making this a list means BAL-475 ADDS A ROOT — one line — rather than restructuring the
 * scan under deadline, which is when a ban quietly stops applying.
 *
 * A root that matches nothing is a typo, not a pass: the non-vacuity block below asserts each
 * entry contributed at least one scanned file.
 */
const CALENDAR_WRITE_DIRS = [CONSULTATION_EVENTS_DIR] as const;

/**
 * The SDK's attendee type — `CreateEventInput.attendees?: EventAttendee[]` in
 * `@apiroc/unified-calendar-api-node-sdk`.
 *
 * ⚠ DELIBERATELY NARROW, AND THAT IS WHY IT CAN BE TREE-WIDE. Importing or naming this type
 * anywhere under `apps/api/src` is an unambiguous statement of intent to send attendees, and it
 * has ZERO legitimate uses. A future recap feature that legitimately lists "attendees" of a
 * meeting is untouched by it — which is what stops this scan from becoming an allowlist that
 * grows, the failure `apps/web/src/invariants/_read-only-actions.ts` records from BAL-424.
 */
const VENDOR_ATTENDEE_TYPE = ['EventAttendee'] as const;

/** Guards must be able to NAME what they forbid. */
const SCAN_EXEMPT = ['invariants/'] as const;

// ── Layer 1 — DATA: the registry names no address ────────────────────────────────────────

describe('Layer 1 — the calendar context registry is address-free DATA', () => {
  /**
   * Also the D2 non-vacuity guard: a key type that accidentally resolved to `never` would let
   * `{}` satisfy the registry's `Record` and every "for each descriptor…" loop below would
   * iterate nothing.
   */
  it('covers exactly the five bookable contexts (guards a vacuous pass)', () => {
    expect(Object.keys(CALENDAR_CONTEXT_REGISTRY).sort()).toEqual(
      [...BOOKABLE_CONTEXT_TYPES].sort()
    );
    expect(Object.keys(CALENDAR_CONTEXT_REGISTRY).length).toBeGreaterThanOrEqual(5);
  });

  it('every eventLabel is a non-empty string carrying no address token', () => {
    for (const [contextType, descriptor] of Object.entries(CALENDAR_CONTEXT_REGISTRY)) {
      expect(typeof descriptor.eventLabel).toBe('string');
      expect(descriptor.eventLabel.trim().length).toBeGreaterThan(0);
      for (const token of ['@', 'mailto', '.com']) {
        expect(
          descriptor.eventLabel,
          `${contextType}: "${token}" in an eventLabel. ${REMEDY}`
        ).not.toContain(token);
      }
    }
  });

  it('every subjectSource is one of the THREE closed kinds — a fourth is a decision', () => {
    for (const [contextType, descriptor] of Object.entries(CALENDAR_CONTEXT_REGISTRY)) {
      expect(
        CALENDAR_SUBJECT_SOURCES,
        `${contextType} names subject source "${descriptor.subjectSource}", which is not one of the three`
      ).toContain(descriptor.subjectSource);
    }
  });
});

// ── Layer 2 — RULE: the vendor payload's key set is CLOSED ───────────────────────────────

describe('Layer 2 — the vendor event payload has an exactly-pinned key set', () => {
  /**
   * ⚠ AN EXACT KEY-SET PIN, NOT `expect(event.attendees).toBeUndefined()`. The latter is what
   * the three existing unit tests assert; it catches ONE field name. This fails on ANY new key
   * — `organizer`, `guests`, `emails`, `invitees`, `attendeesOmitted` — which is the whole
   * reason this layer exists beside them rather than instead of them.
   */
  it('builds exactly seven keys and no eighth', () => {
    const event = buildConsultationEvent({
      title: 'Consultation with Northwind Industrial',
      caseTitle: 'CPQ rollout',
      startAt: new Date('2026-09-01T04:00:00.000Z'),
      endAt: new Date('2026-09-01T04:30:00.000Z'),
      baloBookingId: 'meeting-1',
      joinUrl: 'https://balo.expert/join/m/meeting-1',
    });

    expect(Object.keys(event).sort(), REMEDY).toEqual([
      'description',
      'end',
      'location',
      'privateExtendedProperties',
      'start',
      'title',
      'transparency',
    ]);
  });

  it('the same key set with the OPTIONAL subject omitted — no key appears conditionally', () => {
    const event = buildConsultationEvent({
      title: 'Discovery call with Northwind Industrial',
      startAt: new Date('2026-09-01T04:00:00.000Z'),
      endAt: new Date('2026-09-01T04:30:00.000Z'),
      baloBookingId: 'meeting-2',
      joinUrl: 'https://balo.expert/join/m/meeting-2',
    });

    expect(Object.keys(event).sort(), REMEDY).toEqual([
      'description',
      'end',
      'location',
      'privateExtendedProperties',
      'start',
      'title',
      'transparency',
    ]);
  });

  it("the only identifier the payload carries is Balo's own booking tag", () => {
    const event = buildConsultationEvent({
      title: 'Intro call with Northwind Industrial',
      startAt: new Date('2026-09-01T04:00:00.000Z'),
      endAt: new Date('2026-09-01T04:30:00.000Z'),
      baloBookingId: 'meeting-3',
      joinUrl: 'https://balo.expert/join/m/meeting-3',
    });

    expect(event.privateExtendedProperties).toEqual({ baloBookingId: 'meeting-3' });
  });
});

// ── Layer 3 / Scan A — the address vocabulary is absent from the calendar-write tree ─────

describe('Layer 3 / Scan A — no module under a calendar-write directory names an address', () => {
  const scanned = ALL_SOURCE_FILES.filter((rel) => isUnderAny(rel, CALENDAR_WRITE_DIRS));

  it('scans every calendar-write directory (guards a vacuous pass)', () => {
    // Ten non-test modules today. The floor is deliberately loose — this asserts "the walk
    // ran and found the directory", not a file census. A walk that resolved the wrong path, or
    // silently returned [], would pass every absence assertion below for the wrong reason.
    expect(scanned.length).toBeGreaterThanOrEqual(7);
    expect(scanned).toContain(`${CONSULTATION_EVENTS_DIR}event-mapper.ts`);
    expect(scanned).toContain(`${CONSULTATION_EVENTS_DIR}write-consultation-event.ts`);
    // BAL-433's own three modules — proof that a NEW file auto-enrols rather than opting out.
    expect(scanned).toContain(`${CONSULTATION_EVENTS_DIR}calendar-context-registry.ts`);
    expect(scanned).toContain(`${CONSULTATION_EVENTS_DIR}resolve-calendar-facts.ts`);
    expect(scanned).toContain(`${CONSULTATION_EVENTS_DIR}booking-calendar-projection.ts`);
  });

  it('⚠ every declared root contributed a file — a root that matches nothing is a typo', () => {
    // The cost of the list form: a misspelled or since-renamed root scans NOTHING and every
    // absence assertion below still passes. This is the assertion that makes adding a root for
    // BAL-475 a one-line change that cannot silently do nothing.
    for (const root of CALENDAR_WRITE_DIRS) {
      expect(
        scanned.filter((rel) => rel.startsWith(root)).length,
        `no source file under declared calendar-write root "${root}"`
      ).toBeGreaterThan(0);
    }
  });

  it('every scanned file reads as non-empty (a silent read failure is a vacuous pass)', () => {
    for (const rel of scanned) {
      expect(readRaw(rel).length, `${rel} read as empty`).toBeGreaterThan(0);
    }
  });

  it.each([...scanned])('%s names no attendee and no address', (rel) => {
    expect(markersInCode(readRaw(rel), ADDRESS_MARKERS), `${rel}. ${REMEDY}`).toEqual([]);
  });
});

// ── Layer 3 / Scan B — the vendor's attendee TYPE is absent tree-wide ────────────────────

describe("Layer 3 / Scan B — nobody in apps/api names the SDK's attendee type", () => {
  const scanned = ALL_SOURCE_FILES.filter((rel) => !isUnderAny(rel, SCAN_EXEMPT));

  it('scans the full apps/api source surface (guards a vacuous pass)', () => {
    expect(ALL_SOURCE_FILES.length).toBeGreaterThan(200);
    expect(ALL_SOURCE_FILES).toContain(`${CONSULTATION_EVENTS_DIR}event-mapper.ts`);
    expect(ALL_SOURCE_FILES).toContain('jobs/worker.ts');
    // The exemption removed something, and removed only what it claims to.
    expect(ALL_SOURCE_FILES.length - scanned.length).toBeGreaterThan(0);
    expect(scanned.some((rel) => rel.startsWith('invariants/'))).toBe(false);
  });

  it('no file imports or names EventAttendee', () => {
    const offenders = scanned.filter(
      (rel) => markersInCode(readRaw(rel), VENDOR_ATTENDEE_TYPE).length > 0
    );
    expect(offenders, `${offenders.join(', ')}. ${REMEDY}`).toEqual([]);
  });
});

// ── Positive controls — a scan that matches nothing proves nothing ───────────────────────

describe('the matchers actually fire (a scan that has never been seen to match proves nothing)', () => {
  it('matches an attendee field written as CODE', () => {
    expect(markersInCode('const x = { attendees: [] };', ADDRESS_MARKERS)).toEqual([
      'attendees',
      'attendee',
    ]);
  });

  it('matches an address written as CODE', () => {
    expect(markersInCode("const to = 'mailto:someone';", ADDRESS_MARKERS)).toEqual(['mailto']);
    expect(markersInCode('const recipientEmail = row.email;', ADDRESS_MARKERS)).toEqual([
      'email',
      'Email',
    ]);
  });

  it('⚠ does NOT match a COMMENT — the classifier is live', () => {
    // Load-bearing: every file under the calendar-write directory EXPLAINS in prose that it
    // sends no attendees. A scan that counted those explanations would be unsatisfiable, and
    // the natural "fix" would be to delete the explanations.
    expect(
      markersInCode('// attendees are never set on a Balo-written event', ADDRESS_MARKERS)
    ).toEqual([]);
    expect(
      markersInCode(' * NO attendees — the client is deliberately NOT invited.', ADDRESS_MARKERS)
    ).toEqual([]);
  });

  it('matches the vendor attendee type in an import', () => {
    expect(
      markersInCode(
        "import type { EventAttendee } from '@apiroc/unified-calendar-api-node-sdk';",
        VENDOR_ATTENDEE_TYPE
      )
    ).toEqual(['EventAttendee']);
  });

  it('⚠ a trailing comment after real code still trips the scan (false ALARM, never false PASS)', () => {
    // The classifier drops whole comment LINES only. A marker after a trailing `//` is kept —
    // wrong in the safe direction for a fail-closed invariant.
    expect(markersInCode('const x = 1; // attendees', ADDRESS_MARKERS)).toEqual([
      'attendees',
      'attendee',
    ]);
  });
});
