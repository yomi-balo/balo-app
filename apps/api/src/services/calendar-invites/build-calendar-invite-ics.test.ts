import { describe, expect, it } from 'vitest';
import { escapeIcsText } from '@balo/shared/calendar';
import { unfoldIcs as unfold } from '../../test/fixtures/ics-assertions.js';
import {
  buildCalendarInviteIcs,
  type BuildCalendarInviteIcsInput,
} from './build-calendar-invite-ics.js';

const BASE_INPUT: BuildCalendarInviteIcsInput = {
  uid: '5b7c1d2e-8f90-4a1b-9c3d-4e5f6a7b8c9d',
  sequence: 0,
  summary: 'Consultation with Northwind Industrial',
  description: 'CPQ rollout\n\nJoin: https://balo.expert/meetings/abc/call',
  location: 'https://balo.expert/meetings/abc/call',
  startAt: new Date('2026-09-01T04:00:00.000Z'),
  endAt: new Date('2026-09-01T04:30:00.000Z'),
  stampAt: new Date('2026-08-20T00:00:00.000Z'),
  organizerAddress: 'no-reply@balo.test',
  recipientAddress: 'recipient@example.test',
  method: 'REQUEST',
};

describe('BuildCalendarInviteIcsInput — F10(a) (fix round 1, S5(a)) — the key set is pinned exactly', () => {
  /**
   * A `Required<...>` fixture. If a future edit adds ANY field to
   * `BuildCalendarInviteIcsInput` — optional or not — this literal fails to compile until a
   * value is added here too, since `Required<>` strips every field's optionality including a
   * brand-new one. That is the compile-time half of the pin; the runtime assertion below is the
   * other half (a key rename or a key that quietly stopped mattering).
   */
  const REQUIRED_FIXTURE: Required<BuildCalendarInviteIcsInput> = {
    uid: BASE_INPUT.uid,
    sequence: BASE_INPUT.sequence,
    summary: BASE_INPUT.summary,
    description: BASE_INPUT.description,
    location: BASE_INPUT.location ?? 'https://balo.expert/meetings/abc/call',
    startAt: BASE_INPUT.startAt,
    endAt: BASE_INPUT.endAt,
    stampAt: BASE_INPUT.stampAt,
    organizerAddress: BASE_INPUT.organizerAddress,
    recipientAddress: BASE_INPUT.recipientAddress,
    method: BASE_INPUT.method,
  };

  it('has exactly these eleven keys and no twelfth', () => {
    expect(Object.keys(REQUIRED_FIXTURE).sort((a, b) => a.localeCompare(b))).toEqual([
      'description',
      'endAt',
      'location',
      'method',
      'organizerAddress',
      'recipientAddress',
      'sequence',
      'stampAt',
      'startAt',
      'summary',
      'uid',
    ]);
  });
});

describe('buildCalendarInviteIcs', () => {
  it('emits METHOD:REQUEST, STATUS:CONFIRMED, the given UID and SEQUENCE, and UTC DTSTAMP/DTSTART/DTEND', () => {
    const lines = unfold(buildCalendarInviteIcs(BASE_INPUT));

    expect(lines).toContain('METHOD:REQUEST');
    expect(lines).toContain('STATUS:CONFIRMED');
    expect(lines.some((l) => l === `UID:${BASE_INPUT.uid}`)).toBe(true);
    expect(lines.some((l) => l === 'SEQUENCE:0')).toBe(true);
    expect(lines.some((l) => l.startsWith('DTSTAMP:') && l.endsWith('Z'))).toBe(true);
    expect(lines.some((l) => l.startsWith('DTSTART:') && l.endsWith('Z'))).toBe(true);
    expect(lines.some((l) => l.startsWith('DTEND:') && l.endsWith('Z'))).toBe(true);
  });

  it('emits exactly one ATTENDEE line, equal to ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=FALSE:MAILTO:<recipient>', () => {
    const lines = unfold(buildCalendarInviteIcs(BASE_INPUT));
    const attendeeLines = lines.filter((l) => l.startsWith('ATTENDEE'));

    expect(attendeeLines).toHaveLength(1);
    expect(attendeeLines[0]).toBe(
      'ATTENDEE;ROLE=REQ-PARTICIPANT;RSVP=FALSE:MAILTO:recipient@example.test'
    );
  });

  it('emits exactly one ORGANIZER line, ORGANIZER;CN="Balo":mailto:<organizer>', () => {
    const lines = unfold(buildCalendarInviteIcs(BASE_INPUT));
    const organizerLines = lines.filter((l) => l.startsWith('ORGANIZER'));

    expect(organizerLines).toHaveLength(1);
    expect(organizerLines[0]).toBe('ORGANIZER;CN="Balo":mailto:no-reply@balo.test');
  });

  it('ends with END:VCALENDAR and every line is CRLF-terminated', () => {
    const ics = buildCalendarInviteIcs(BASE_INPUT);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    // no lone \n without a preceding \r anywhere
    expect(ics.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('the same uid is stable across two builds with different sequences', () => {
    const first = unfold(buildCalendarInviteIcs({ ...BASE_INPUT, sequence: 0 }));
    const second = unfold(buildCalendarInviteIcs({ ...BASE_INPUT, sequence: 2 }));
    const uidOf = (lines: string[]): string | undefined => lines.find((l) => l.startsWith('UID:'));
    expect(uidOf(first)).toBe(uidOf(second));
    expect(second).toContain('SEQUENCE:2');
  });

  describe('BAL-283 regression — the shared escaper is the conformance oracle', () => {
    const VECTORS = [
      'Dana\r\nATTENDEE;CN=Dana:mailto:attacker@evil.com',
      'Intro call\nBEGIN:VALARM\nACTION:EMAIL\nEND:VALARM',
      String.raw`A\B;C,D`,
    ];

    it.each(VECTORS)('summary vector %#: matches the shared escaper exactly', (vector) => {
      const benign = unfold(buildCalendarInviteIcs(BASE_INPUT));
      const lines = unfold(buildCalendarInviteIcs({ ...BASE_INPUT, summary: vector }));

      const summaryLine = lines.find((l) => l.startsWith('SUMMARY:'));
      expect(summaryLine).toBe(`SUMMARY:${escapeIcsText(vector)}`);
      expect(lines.filter((l) => l.startsWith('ATTENDEE'))).toHaveLength(1);
      expect(lines.some((l) => l.startsWith('BEGIN:VALARM'))).toBe(false);
      expect(lines.length).toBe(benign.length);
    });

    it.each(VECTORS)('description vector %#: matches the shared escaper exactly', (vector) => {
      const lines = unfold(buildCalendarInviteIcs({ ...BASE_INPUT, description: vector }));

      const descriptionLine = lines.find((l) => l.startsWith('DESCRIPTION:'));
      expect(descriptionLine).toBe(`DESCRIPTION:${escapeIcsText(vector)}`);
      expect(lines.filter((l) => l.startsWith('ATTENDEE'))).toHaveLength(1);
    });
  });

  it('folds a long summary (>75 octets) and unfolds it back to the escaped text', () => {
    const longSummary = 'A'.repeat(120);
    const ics = buildCalendarInviteIcs({ ...BASE_INPUT, summary: longSummary });

    // Confirms folding actually happened somewhere in the raw (unfolded) output.
    expect(ics).toContain('\r\n ');

    const lines = unfold(ics);
    expect(lines.find((l) => l.startsWith('SUMMARY:'))).toBe(`SUMMARY:${longSummary}`);
  });
});

// ── BAL-476 — the WITHDRAWAL, out of the same builder ─────────────────────────────────────

describe('buildCalendarInviteIcs — METHOD:CANCEL', () => {
  it('⚠ emits METHOD:CANCEL and STATUS:CANCELLED, with the SAME UID and the SAME SEQUENCE', () => {
    const request = unfold(buildCalendarInviteIcs({ ...BASE_INPUT, sequence: 3 }));
    const cancel = unfold(buildCalendarInviteIcs({ ...BASE_INPUT, sequence: 3, method: 'CANCEL' }));

    expect(cancel).toContain('METHOD:CANCEL');
    expect(cancel).toContain('STATUS:CANCELLED');
    expect(cancel).not.toContain('METHOD:REQUEST');
    expect(cancel).not.toContain('STATUS:CONFIRMED');

    // ⚠ R2 — the withdrawal addresses the series it is retiring: SAME uid, and NO sequence bump.
    const uidLine = `UID:${BASE_INPUT.uid}`;
    expect(request).toContain(uidLine);
    expect(cancel).toContain(uidLine);
    expect(request).toContain('SEQUENCE:3');
    expect(cancel).toContain('SEQUENCE:3');
  });

  it('⚠ still emits exactly ONE ATTENDEE — RFC 5546 §3.2.5 requires it on a targeted CANCEL', () => {
    const lines = unfold(buildCalendarInviteIcs({ ...BASE_INPUT, method: 'CANCEL' }));
    const attendeeLines = lines.filter((l) => l.startsWith('ATTENDEE'));

    expect(attendeeLines).toHaveLength(1);
    expect(attendeeLines[0]).toContain(BASE_INPUT.recipientAddress);
  });

  it('⚠ the two methods differ ONLY in METHOD and STATUS — nothing else moves', () => {
    const request = unfold(buildCalendarInviteIcs(BASE_INPUT));
    const cancel = unfold(buildCalendarInviteIcs({ ...BASE_INPUT, method: 'CANCEL' }));

    expect(request).toHaveLength(cancel.length);
    const differing = request.filter((line, index) => line !== cancel[index]);
    expect(differing).toEqual(['METHOD:REQUEST', 'STATUS:CONFIRMED']);
  });
});
