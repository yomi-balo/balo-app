import { describe, it, expect } from 'vitest';

import {
  MEETING_ALLOWED_CONTENT_TYPES,
  MAX_MEETING_FILE_BYTES,
  MEETING_FILE_ACCEPT,
  sanitizeMeetingFileName,
} from './meeting-file-constraints';
import {
  CONVERSATION_ALLOWED_CONTENT_TYPES,
  MAX_CONVERSATION_FILE_BYTES,
} from './conversation-file-constraints';

describe('meeting-file constraints', () => {
  it('caps in-call files at 10 MB', () => {
    expect(MAX_MEETING_FILE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('allows the nine in-case document types', () => {
    for (const type of [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/csv',
      'text/plain',
    ]) {
      expect(MEETING_ALLOWED_CONTENT_TYPES.has(type)).toBe(true);
    }
    expect(MEETING_ALLOWED_CONTENT_TYPES.size).toBe(9);
  });

  it('rejects an executable content type', () => {
    expect(MEETING_ALLOWED_CONTENT_TYPES.has('application/x-msdownload')).toBe(false);
  });

  /**
   * ⚠ THE PARITY ASSERTION. BAL-421 merges `conversation_files` and `meeting_files` on READ,
   * so the two scopes must present ONE vocabulary — a file shareable between calls and
   * unshareable during one would be an arbitrary cliff inside a single rendered list. This
   * makes a future divergence a conscious edit to a failing test, never a silent drift.
   */
  it('presents ONE vocabulary with the conversation scope (the BAL-421 merge)', () => {
    expect([...MEETING_ALLOWED_CONTENT_TYPES].sort((a, b) => a.localeCompare(b))).toEqual(
      [...CONVERSATION_ALLOWED_CONTENT_TYPES].sort((a, b) => a.localeCompare(b))
    );
    expect(MAX_MEETING_FILE_BYTES).toBe(MAX_CONVERSATION_FILE_BYTES);
  });

  it('offers an accept string covering every allowed type', () => {
    const extensions = MEETING_FILE_ACCEPT.split(',');
    // Image types are listed by MIME, documents by extension — mirrors the conversation input.
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(extensions).toContain(mime);
    }
    for (const extension of ['.pdf', '.docx', '.xlsx', '.pptx', '.csv', '.txt']) {
      expect(extensions).toContain(extension);
    }
    expect(extensions).toHaveLength(MEETING_ALLOWED_CONTENT_TYPES.size);
  });
});

/**
 * ⚠⚠ THE DISGUISED-EXECUTABLE DEFENCE. `U+202E` (and its eight relatives) reorder every glyph
 * AFTER them without changing the code points, so `invoice` + `U+202E` + `gnp.exe` is stored,
 * sorted and matched as an `.exe` while RENDERING everywhere as `invoice.png`. Stripping at
 * WRITE time is what makes every present and future reader safe by default — the list, chat,
 * the download's `Content-Disposition`, BAL-421's merged case view.
 *
 * ⚠ THE CONTROLS ARE BUILT WITH `String.fromCodePoint`, NEVER PASTED. Pasting them into this
 * test file would reorder the SOURCE in every editor and diff view — the same trick, aimed at
 * the reviewer.
 */
describe('sanitizeMeetingFileName', () => {
  const control = (codePoint: number): string => String.fromCodePoint(codePoint);

  const BIDI_CONTROLS = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

  it.each(BIDI_CONTROLS)('strips code point %i', (codePoint) => {
    expect(sanitizeMeetingFileName(`a${control(codePoint)}b.pdf`)).toBe('ab.pdf');
  });

  it('defuses the canonical RTL-override disguise', () => {
    expect(sanitizeMeetingFileName(`invoice${control(0x202e)}gnp.exe`)).toBe('invoicegnp.exe');
  });

  it('strips every occurrence, not just the first', () => {
    const crafted = `${control(0x202e)}a${control(0x2066)}b${control(0x202d)}.pdf`;
    expect(sanitizeMeetingFileName(crafted)).toBe('ab.pdf');
  });

  it('returns the empty string for a name made ENTIRELY of controls (a rejection signal)', () => {
    expect(sanitizeMeetingFileName(BIDI_CONTROLS.map(control).join(''))).toBe('');
  });

  it('trims, so a name that is only controls plus whitespace also empties', () => {
    expect(sanitizeMeetingFileName(`  ${control(0x202e)}  `)).toBe('');
  });

  /**
   * ⚠ THESE NINE ONLY — it is not a filename allow-list. LRM/RLM are ordinary marks that
   * legitimately appear in Hebrew and Arabic names and do NOT override the following run;
   * stripping them would corrupt real names for no security gain.
   */
  it.each([
    { label: 'plain ASCII', input: 'deck.pdf', expected: 'deck.pdf' },
    { label: 'Cyrillic and CJK', input: 'Q3 план 提案.pdf', expected: 'Q3 план 提案.pdf' },
    {
      label: 'LRM (U+200E)',
      input: `a${control(0x200e)}b.pdf`,
      expected: `a${control(0x200e)}b.pdf`,
    },
    {
      label: 'RLM (U+200F)',
      input: `a${control(0x200f)}b.pdf`,
      expected: `a${control(0x200f)}b.pdf`,
    },
  ])('leaves $label alone', ({ input, expected }) => {
    expect(sanitizeMeetingFileName(input)).toBe(expected);
  });

  /** Spreading the string preserves astral code points instead of tearing surrogate pairs. */
  it('preserves astral characters intact', () => {
    const name = `report${String.fromCodePoint(0x1f4c8)}.pdf`;
    expect(sanitizeMeetingFileName(name)).toBe(name);
  });
});
