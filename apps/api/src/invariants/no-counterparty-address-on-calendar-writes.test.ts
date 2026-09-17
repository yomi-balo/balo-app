import { describe, it, expect } from 'vitest';
import { BOOKABLE_CONTEXT_TYPES } from '@balo/shared/meetings';
import {
  CALENDAR_CONTEXT_REGISTRY,
  CALENDAR_SUBJECT_SOURCES,
} from '../services/consultation-events/calendar-context-registry.js';
import { buildConsultationEvent } from '../services/consultation-events/event-mapper.js';
import { buildCalendarInviteIcs } from '../services/calendar-invites/build-calendar-invite-ics.js';
import { icsAddressPropertyNames, unfoldIcs as unfold } from '../test/fixtures/ics-assertions.js';
import {
  ALL_SOURCE_FILES,
  functionBodyLines,
  isCommentLine,
  isUnderAny,
  markerLinesInCode,
  markersInCode,
  readRaw,
} from './_source-scan.js';

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
 *   · Layer 3 (SOURCE) — nobody has WRITTEN the MARKER VOCABULARY anywhere under a
 *                        calendar-write directory (`CALENDAR_WRITE_DIRS`, a LIST — BAL-475's
 *                        ICS builder ADDS a second root, `services/calendar-invites/`, instead
 *                        of escaping the ban), and nobody names the vendor's attendee TYPE
 *                        anywhere in `apps/api/src`.
 *
 * ⚠⚠⚠ SCAN A IS A LEXICAL MARKER SCAN, NOT AN ADDRESS SCAN (fix round 1, R9/S5) — SAY SO
 * PLAINLY, BECAUSE THE OLD WORDING OVERCLAIMED IT. "A third address-bearing line … fails" reads
 * as "any code that carries an address fails", which is false: Scan A matches literal
 * occurrences of `ADDRESS_MARKERS` below (`attendee(s)`, `mailto`, `email` in four casings) —
 * an identifier like `organizerAddress` or `recipientAddress` contains NONE of them and is
 * INVISIBLE to this scan, by construction. Two things backstop that gap for
 * `services/calendar-invites/` specifically:
 *   · Layer 2b (below) is a BEHAVIOURAL check on a BUILT invite's actual output — it catches an
 *     unconditional third address regardless of what the source-level variable was named.
 *   · F10(b) additionally bans the literal tokens `.x(` and `CONTACT` under
 *     `CALENDAR_INVITES_DIR` — ical-generator's custom-property escape hatch is exactly how a
 *     conditional (fixture-invisible) third address reaches the wire with no marker in its own
 *     name (this file's own M6 finding).
 *   · The delivery module (`notifications/channels/calendar-invite-delivery.ts`) — the ONE
 *     place an address is actually resolved — sits under NEITHER scanned root and is guarded
 *     instead by an END-TO-END unit test with the REAL builder (F8(a) fix round 1, R7a), which
 *     asserts the ICS handed to the transport has only the resolved recipient's own address.
 * None of this weakens what IS checked; it is a correction to what the comments CLAIMED was
 * checked, which is a distinct kind of bug — a test that reads more powerful than it is.
 *
 * ⚠⚠ BAL-475 (U1) — THE ONE PINNED EXCEPTION. `services/calendar-invites/` is the SECOND scan
 * root, and it is allowed to name EXACTLY one address vocabulary: the recipient's own address
 * (the "self" ATTENDEE) and Balo's own ORGANIZER, on the two verbatim lines named by
 * `RECIPIENT_SELF_EXCEPTION` below, inside `buildCalendarInviteIcs` and nowhere else. This is
 * ADR-1044's amendment 2026-09-17: a Balo-organised ICS may name only its recipient (one
 * ATTENDEE) and Balo (ORGANIZER) — never a counterparty. Everything else this file already
 * says about Layer 3 — walk-derived subjects, no pinned file list, non-vacuity per root —
 * applies to this root exactly as it does to `services/consultation-events/`.
 *
 * ⚠ THE CHANNEL LABEL `'email'` IS EXPRESSED THROUGH `CALENDAR_INVITE_CHANNEL` (fix round 1,
 * F19 — R19), a constant declared OUTSIDE this scan's roots (`notifications/calendar-invite-
 * spec.ts`), never as a literal inside them — so `services/calendar-invites/log-fields.ts` can
 * reference the channel without writing the banned token itself. This is a deliberate,
 * documented accommodation of the scan, not a bypass of the RULING: the constant's VALUE still
 * carries no counterparty address, and nothing under either root ever reads an address off it.
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

/** BAL-475 — the Balo-organised ICS invite modules. The invariant's SECOND root. */
const CALENDAR_INVITES_DIR = 'services/calendar-invites/';

/**
 * EVERY calendar-artefact root Scan A covers.
 *
 * ⚠ THE SHAPE IS THE POINT. Scan A's auto-enrolment property (a new module lands in the subject
 * set the moment it exists) holds WITHIN a root, not across the app: a calendar artefact written
 * somewhere else — say `services/ics/build-invite.ts` — would name `email` or `mailto` freely and
 * this suite would stay green. BAL-475 (ICS delivery) IS the module that needs an address (it
 * must send an invite to someone), so the boundary between "the recipient's own address" and
 * "the counterparty's address" (the ADR-1044 §3 ban) is exactly what it has to argue — which it
 * does via `RECIPIENT_SELF_EXCEPTION` below, not by escaping the scan.
 *
 * A root that matches nothing is a typo, not a pass: the non-vacuity block below asserts each
 * entry contributed at least one scanned file.
 */
const CALENDAR_WRITE_DIRS = [CONSULTATION_EVENTS_DIR, CALENDAR_INVITES_DIR] as const;

/**
 * ADR-1044 amendment 2026-09-17 (BAL-475, U1) — THE ONLY PERMITTED ADDRESS VOCABULARY UNDER ANY
 * CALENDAR-WRITE ROOT: the recipient-self ATTENDEE and Balo's ORGANIZER, in ONE file, inside ONE
 * function, on exactly these TWO code lines (trimmed, in this order). Not a directory allowlist
 * and not a file allowlist: a third MARKER-bearing line anywhere in this file (fix round 1,
 * R9 — Scan A matches `ADDRESS_MARKERS`, not every possible address; see the file docblock),
 * either line moved out of the function, or any marker-bearing line in any OTHER file under
 * either root, fails.
 */
const RECIPIENT_SELF_EXCEPTION = {
  file: `${CALENDAR_INVITES_DIR}build-calendar-invite-ics.ts`,
  functionSignaturePrefix: 'export function buildCalendarInviteIcs(',
  lines: [
    'organizer: { name: CALENDAR_INVITE_ORGANIZER_NAME, email: input.organizerAddress },',
    'event.createAttendee({ email: input.recipientAddress, rsvp: false });',
  ],
} as const;

/** ADR-1044 amendment 2026-09-17: a Balo-organised ICS may name only its recipient (one
 *  ATTENDEE) and Balo (ORGANIZER). Any other address is a decision — amend ADR-1044 first. */
const REMEDY_ICS =
  'ADR-1044 amendment 2026-09-17: a Balo-organised ICS may name only its recipient (one ' +
  'ATTENDEE) and Balo (ORGANIZER). Any other address is a decision — amend ADR-1044 first.';

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
    expect(Object.keys(CALENDAR_CONTEXT_REGISTRY).sort((a, b) => a.localeCompare(b))).toEqual(
      [...BOOKABLE_CONTEXT_TYPES].sort((a, b) => a.localeCompare(b))
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

    expect(
      Object.keys(event).sort((a, b) => a.localeCompare(b)),
      REMEDY
    ).toEqual([
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

    expect(
      Object.keys(event).sort((a, b) => a.localeCompare(b)),
      REMEDY
    ).toEqual([
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

  /** BAL-475 — the second root's own modules, proof it auto-enrols the same way the first did. */
  it('⚠ the calendar-invites root is scanned, including the pinned-exception file itself', () => {
    expect(scanned).toContain(RECIPIENT_SELF_EXCEPTION.file);
    expect(scanned).toContain(`${CALENDAR_INVITES_DIR}resolve-calendar-invite-recipients.ts`);
    expect(scanned).toContain(`${CALENDAR_INVITES_DIR}publish-calendar-invites.ts`);
    expect(scanned).toContain(`${CALENDAR_INVITES_DIR}resolve-calendar-invite-facts.ts`);
  });

  it('every scanned file reads as non-empty (a silent read failure is a vacuous pass)', () => {
    for (const rel of scanned) {
      expect(readRaw(rel).length, `${rel} read as empty`).toBeGreaterThan(0);
    }
  });

  it.each([...scanned])(
    '%s names no address beyond the one pinned recipient-self exception',
    (rel) => {
      const raw = readRaw(rel);
      if (rel === RECIPIENT_SELF_EXCEPTION.file) {
        expect(markerLinesInCode(raw, ADDRESS_MARKERS), `${rel}. ${REMEDY_ICS}`).toEqual([
          ...RECIPIENT_SELF_EXCEPTION.lines,
        ]);
        const body = functionBodyLines(raw, RECIPIENT_SELF_EXCEPTION.functionSignaturePrefix);
        expect(body.length, `${rel}: buildCalendarInviteIcs body not found`).toBeGreaterThan(0);
        for (const line of RECIPIENT_SELF_EXCEPTION.lines) {
          expect(
            body,
            `${rel}: "${line}" must stay inside buildCalendarInviteIcs. ${REMEDY_ICS}`
          ).toContain(line);
        }
        return;
      }
      expect(markersInCode(raw, ADDRESS_MARKERS), `${rel}. ${REMEDY}`).toEqual([]);
    }
  );

  /**
   * F10(b) (fix round 1, S5(a)/(b)) — under `CALENDAR_INVITES_DIR` specifically, ALSO ban
   * `.x(` (ical-generator's custom-property escape hatch — `event.x([['CONTACT', addr]])`
   * renders an arbitrary RFC 5545 property with NO marker in its own name) and the literal
   * `CONTACT`. Neither token appears in `ADDRESS_MARKERS`, so M6's residual (a conditional
   * `CONTACT` line, reachable without tripping Scan A at all) is closed here rather than by
   * widening the address-marker vocabulary itself.
   */
  const CALENDAR_INVITES_BANNED_TOKENS = ['.x(', 'CONTACT'] as const;
  const calendarInvitesFiles = scanned.filter((rel) => rel.startsWith(CALENDAR_INVITES_DIR));

  it('⚠ scans at least one calendar-invites file for the .x(/CONTACT ban (guards a vacuous pass)', () => {
    expect(calendarInvitesFiles.length).toBeGreaterThan(0);
  });

  it.each([...calendarInvitesFiles])('%s contains no `.x(` call and no literal CONTACT', (rel) => {
    const raw = readRaw(rel);
    expect(markersInCode(raw, CALENDAR_INVITES_BANNED_TOKENS), `${rel}. ${REMEDY_ICS}`).toEqual([]);
  });
});

// ── Positive controls for the LINE-level helpers (BAL-475) ───────────────────────────────

describe('markerLinesInCode / functionBodyLines — the matchers actually fire', () => {
  it('markerLinesInCode returns the trimmed CODE line containing a marker, skipping comments', () => {
    expect(
      markerLinesInCode('// email here\nconst a = x.email;\n * mailto', ADDRESS_MARKERS)
    ).toEqual(['const a = x.email;']);
  });

  it('functionBodyLines returns the lines strictly between the signature and the closing brace', () => {
    expect(
      functionBodyLines('export function f(\n  a;\n  b;\n}\nconst c;', 'export function f(')
    ).toEqual(['a;', 'b;']);
  });

  it('functionBodyLines returns [] when the signature prefix is absent', () => {
    expect(functionBodyLines('const c;', 'export function f(')).toEqual([]);
  });

  // ── F10(d) (fix round 1, S5(d)) — isCommentLine: code AFTER a same-line `/* */` is CODE ──

  it('a same-line block comment with NOTHING after its close is still a comment line', () => {
    expect(isCommentLine('/* just a comment */')).toBe(true);
    expect(isCommentLine('  /* trailing-whitespace-only after close */   ')).toBe(true);
  });

  it('a same-line block comment with CODE after its close is a CODE line, not a comment', () => {
    expect(isCommentLine('/* */ const a = x.email;')).toBe(false);
  });

  it('a genuinely open block comment (no closing */ on this line) is still a comment line', () => {
    expect(isCommentLine('/* this comment keeps going')).toBe(true);
  });

  it('markersInCode now fires on a marker hidden after a same-line /* */ (the evasion F10(d) closes)', () => {
    expect(markersInCode('/* */ const a = user.email;', ADDRESS_MARKERS)).toEqual(['email']);
  });
});

// ── Layer 2b — a BUILT invite names exactly the organizer and the recipient (BAL-475) ────

describe('Layer 2b — a built calendar invite names exactly Balo and its one recipient', () => {
  const BENIGN_FIXTURE = {
    uid: '5b7c1d2e-8f90-4a1b-9c3d-4e5f6a7b8c9d',
    sequence: 0,
    summary: 'Consultation with Northwind Industrial',
    description: 'CPQ rollout\n\nJoin: https://balo.expert/join/m/meeting-1',
    location: 'https://balo.expert/join/m/meeting-1',
    startAt: new Date('2026-09-01T04:00:00.000Z'),
    endAt: new Date('2026-09-01T04:30:00.000Z'),
    stampAt: new Date('2026-08-20T00:00:00.000Z'),
    organizerAddress: 'no-reply@balo.test',
    recipientAddress: 'recipient@example.test',
  };

  it('exactly one ATTENDEE line, RSVP=FALSE, whose value is the recipient address', () => {
    const lines = unfold(buildCalendarInviteIcs(BENIGN_FIXTURE));
    const attendeeLines = lines.filter((l) => l.startsWith('ATTENDEE'));

    expect(attendeeLines).toHaveLength(1);
    expect(attendeeLines[0]).toContain('RSVP=FALSE');
    const [attendeeLine] = attendeeLines;
    const lastColon = (attendeeLine ?? '').lastIndexOf(':');
    expect((attendeeLine ?? '').slice(lastColon + 1)).toBe(BENIGN_FIXTURE.recipientAddress);
  });

  it('every line containing "@" is EITHER ORGANIZER OR ATTENDEE — no third address-bearing property', () => {
    const lines = unfold(buildCalendarInviteIcs(BENIGN_FIXTURE));
    const propertyNames = icsAddressPropertyNames(lines);

    expect([...new Set(propertyNames)].sort((a, b) => a.localeCompare(b))).toEqual([
      'ATTENDEE',
      'ORGANIZER',
    ]);
  });

  it('no CONTACT, no BEGIN:VALARM, no X- custom property', () => {
    const lines = unfold(buildCalendarInviteIcs(BENIGN_FIXTURE));

    expect(lines.some((l) => l.startsWith('CONTACT'))).toBe(false);
    expect(lines.some((l) => l.startsWith('BEGIN:VALARM'))).toBe(false);
    expect(lines.some((l) => l.startsWith('X-'))).toBe(false);
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
