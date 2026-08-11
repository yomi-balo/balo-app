/**
 * Meeting-file constraints (BAL-423 — D0/D1). CLIENT-SAFE on purpose: no `server-only`, no
 * AWS imports, no `@balo/db` value import — so BAL-132's in-call drop-zone and chat paperclip
 * can pre-validate a pick BEFORE any network call. The confirm Server Action re-checks size
 * and type from the R2 object itself; this module is UX, the server is the source of truth.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ⚠ THE ALLOW-LIST IS DELIBERATELY *IDENTICAL* TO `CONVERSATION_ALLOWED_CONTENT_TYPES`.
 * ──────────────────────────────────────────────────────────────────────────────
 * Same nine types, same 10 MB cap. NOT a copy-paste oversight — a decision, because BAL-421
 * MERGES THE TWO FILE SCOPES ON READ. `conversation_files` is the between-call store and
 * `meeting_files` is the in-call one, but a case surface shows them in ONE list. A file that
 * is shareable between calls and unshareable during one (or vice versa) would be an arbitrary
 * cliff inside a single rendered list, with no explanation available to the person hitting it.
 * ONE VOCABULARY across the two in-case scopes.
 *
 * `meeting-file-constraints.test.ts` asserts that parity mechanically, so a future divergence
 * has to be a conscious edit to a failing test rather than a silent drift.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * ⚠ THE 10 MB CAP IS PINNED TO `UPLOAD_TTL_SECONDS = 60` (`./meeting-file.ts`), MECHANICALLY.
 * ──────────────────────────────────────────────────────────────────────────────
 * The browser PUTs directly to R2 against a presigned URL that expires 60 seconds after it is
 * minted. A larger cap lets a slow-connection PUT OUTRUN ITS OWN SIGNATURE and fail opaquely
 * mid-call — the worst possible moment for an unexplained failure. The two numbers are one
 * decision: IF BAL-132 WANTS A LARGER CAP IT MUST RAISE `UPLOAD_TTL_SECONDS` IN THE SAME
 * CHANGE. Raising this constant alone converts a hard client-side rejection into an
 * intermittent, size- and bandwidth-dependent server failure.
 *
 * ⚠ THE CAP IS ALSO BOUND INTO THE PUT SIGNATURE as `ContentLength`, so R2 refuses an
 * over-cap body AT THE EDGE rather than only at the post-hoc HEAD. Raising this constant
 * therefore changes what the storage provider itself accepts — see `meeting-file.ts`.
 */

/**
 * The nine content types an in-call file may carry. Byte-for-byte the conversation set — see
 * the parity rationale above.
 */
export const MEETING_ALLOWED_CONTENT_TYPES = new Set<string>([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'text/plain',
]);

/** 10 MB. ⚠ Pinned to `UPLOAD_TTL_SECONDS = 60` — see the module docblock before raising it. */
export const MAX_MEETING_FILE_BYTES = 10 * 1024 * 1024;

/** Accept attribute for the in-call file input (chat paperclip and Files-tab drop-zone). */
export const MEETING_FILE_ACCEPT =
  '.pdf,image/png,image/jpeg,image/webp,.docx,.xlsx,.pptx,.csv,.txt';

/**
 * The nine BIDI control code points {@link sanitizeMeetingFileName} removes:
 * `U+202A`–`U+202E` (the legacy embedding/override set, including RIGHT-TO-LEFT OVERRIDE) and
 * `U+2066`–`U+2069` (the isolate set).
 *
 * ⚠ SPELLED AS NUMBERS, NOT AS A REGEX CHARACTER CLASS, AND FOR TWO INDEPENDENT REASONS.
 * (1) Pasting the literal characters into this source file would reorder the SOURCE in every
 * editor and every diff view — the same trick, aimed at the reviewer. Never inline them here,
 * in a regex or anywhere else. (2) A numeric membership test over a `Set` is a plain linear
 * scan with no pattern engine behind it, which is the "use a linear non-regex scan" escape
 * hatch from the ReDoS rule (SonarCloud S5852) rather than an argument about why some
 * particular pattern happens to be safe.
 *
 * ⚠ THESE NINE ONLY. `U+200E` / `U+200F` (LRM / RLM) are ordinary marks that legitimately
 * appear in Hebrew and Arabic file names and do NOT override the run that follows them;
 * stripping those would corrupt real names for no security gain.
 */
const BIDI_CONTROL_CODE_POINTS = new Set([
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
]);

/**
 * ⚠⚠ UNICODE BIDI CONTROLS — STRIPPED AT **WRITE** TIME, NOT AT RENDER TIME.
 *
 * These code points reorder the glyphs AFTER them without changing the code points
 * themselves. So the sequence `invoice` + `U+202E` + `gnp.exe` is stored, sorted and matched
 * as an `.exe`, and RENDERS in every browser, mail client and OS file dialog as
 * `invoice.png`. That is the classic disguised-executable trick, and a file name shared
 * mid-call is exactly where a counterparty is most likely to click without looking.
 *
 * ⚠ WHY WRITE TIME, NOT RENDER TIME. A stored name is read by many surfaces — the in-call
 * list, chat, the `Content-Disposition` on the download, BAL-421's merged case view, an email
 * BAL-132 may add later — and any ONE of them forgetting to sanitise reinstates the whole
 * trick. Sanitising once, at the single point of entry, makes every present and future reader
 * safe by default. `createPresignedMeetingFileDownload`'s quote/control-char strip is the same
 * discipline for the HEADER boundary; this is the discipline for the DISPLAY boundary.
 *
 * ⚠ SPREADING THE STRING, NOT `split('')`. Iterating a string yields whole code points, so a
 * name containing astral characters (emoji, some CJK extensions) survives intact rather than
 * being torn into lone surrogates and rejoined.
 *
 * Returns the stripped, trimmed name. ⚠ IT CAN RETURN `''` — a name made ENTIRELY of these
 * controls has nothing left. The caller MUST treat empty as a REJECTION rather than storing
 * it; `confirm-meeting-file-upload.ts` does, and deletes the now-orphaned object.
 */
export function sanitizeMeetingFileName(fileName: string): string {
  return [...fileName]
    .filter((character) => !BIDI_CONTROL_CODE_POINTS.has(character.codePointAt(0) ?? -1))
    .join('')
    .trim();
}
