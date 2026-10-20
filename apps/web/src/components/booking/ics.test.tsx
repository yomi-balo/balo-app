import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { downloadIcsEvent } from './ics';

describe('downloadIcsEvent', () => {
  let clickSpy: ReturnType<typeof vi.fn<() => void>>;
  let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let createdLink: HTMLAnchorElement | undefined;

  beforeEach(() => {
    clickSpy = vi.fn<() => void>();
    createObjectURLSpy = vi
      .spyOn(globalThis.URL, 'createObjectURL')
      .mockReturnValue('blob:mock-url');
    revokeObjectURLSpy = vi.spyOn(globalThis.URL, 'revokeObjectURL').mockImplementation(() => {});
    const realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreateElement(tag);
      if (tag === 'a') {
        createdLink = el as HTMLAnchorElement;
        el.click = clickSpy;
      }
      return el;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    createdLink = undefined;
  });

  it('builds a minimal VCALENDAR/VEVENT blob and triggers a download', () => {
    downloadIcsEvent({
      summary: 'Intro call with Priya',
      startIso: '2026-09-01T04:00:00.000Z',
      durationMinutes: 30,
      filename: 'intro-call.ics',
    });

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    const [blob] = createObjectURLSpy.mock.calls[0] as [Blob];
    expect(blob.type).toBe('text/calendar');
    expect(createdLink?.download).toBe('intro-call.ics');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mock-url');
  });

  it('defaults the filename to event.ics when omitted', () => {
    downloadIcsEvent({
      summary: 'Consultation with Dana',
      startIso: '2026-09-01T04:00:00.000Z',
      durationMinutes: 30,
    });
    expect(createdLink?.download).toBe('event.ics');
  });

  /** Capture the exact text handed to `new Blob([...])`. */
  function captureIcs(summary: string): string {
    let capturedText = '';
    const OriginalBlob = globalThis.Blob;
    vi.spyOn(globalThis, 'Blob').mockImplementation(function (
      parts?: BlobPart[],
      opts?: BlobPropertyBag
    ) {
      capturedText = (parts as string[] | undefined)?.join('') ?? '';
      return new OriginalBlob(parts, opts);
    } as unknown as typeof Blob);

    downloadIcsEvent({
      summary,
      startIso: '2026-09-01T04:00:00.000Z',
      durationMinutes: 30,
    });
    return capturedText;
  }

  it('DTEND is DTSTART + durationMinutes', () => {
    const ics = captureIcs('Intro call');
    expect(ics).toContain('DTSTART:20260901T040000Z');
    expect(ics).toContain('DTEND:20260901T043000Z');
    expect(ics).toContain('SUMMARY:Intro call');
  });

  it('emits the RFC 5545 required properties — PRODID, UID and DTSTAMP', () => {
    const ics = captureIcs('Intro call');
    expect(ics).toContain('PRODID:-//Balo//Balo Booking//EN');
    expect(ics).toMatch(/\r\nUID:[0-9a-f-]{36}@balo\.expert\r\n/);
    expect(ics).toMatch(/\r\nDTSTAMP:\d{8}T\d{6}Z\r\n/);
  });

  it('a UID is unique per download, so two calls never collide in the importing client', () => {
    const first = /UID:([^\r\n]+)/.exec(captureIcs('Intro call'))?.[1];
    vi.restoreAllMocks();
    const second = /UID:([^\r\n]+)/.exec(captureIcs('Intro call'))?.[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  // ── RFC 5545 §3.3.11 injection (round-1 security MEDIUM) ────────────────────────────────
  //
  // A counterparty's own display name reaches `summary`, and a newline is reachable in a first
  // name on BOTH write paths (onboarding `name-step.tsx`, and `update-name.ts`'s `[^<>]` regex,
  // which matches `\n`). If a raw CRLF survived, the input could open a NEW content line and
  // therefore a new property.
  it('never lets a newline in the summary open a new content line (ATTENDEE injection)', () => {
    const ics = captureIcs('Dana\r\nATTENDEE;CN=Dana:mailto:attacker@evil.com');

    // The payload is present only as ESCAPED text on the SUMMARY line…
    expect(ics).toContain('SUMMARY:Dana\\nATTENDEE\\;CN=Dana:mailto:attacker@evil.com');
    // …and never as a real property at the start of a line.
    expect(ics).not.toMatch(/\r\nATTENDEE/);
    // The structure is exactly the eight lines we emit — nothing was added.
    expect(ics.split('\r\n').filter((line) => line.startsWith('ATTENDEE'))).toEqual([]);
  });

  it('a VALARM component cannot be smuggled in through the summary', () => {
    const ics = captureIcs('Intro call\nBEGIN:VALARM\nACTION:EMAIL\nEND:VALARM');
    expect(ics).not.toMatch(/\r\nBEGIN:VALARM/);
    expect(ics).toContain('SUMMARY:Intro call\\nBEGIN:VALARM\\nACTION:EMAIL\\nEND:VALARM');
  });

  it('escapes backslash, semicolon and comma per §3.3.11 — and the backslash FIRST', () => {
    // A literal backslash-n in the input must survive as an escaped backslash followed by a
    // plain `n` (`\\n`), never collapse into the newline escape (`\n`).
    const ics = captureIcs(String.raw`A\B;C,D`);
    expect(ics).toContain('SUMMARY:A\\\\B\\;C\\,D');
  });
});
