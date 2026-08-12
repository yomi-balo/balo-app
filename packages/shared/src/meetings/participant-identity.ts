/**
 * BAL-132 (Decision 1) — THE DAILY `user_id` CLAIM, and the only definition of how to read
 * one back.
 *
 * ⚠⚠ WHY AN ENCODING AT ALL, RATHER THAN THE BARE UUID. A meeting token's `user_id` carries
 * `users.id` for a MEMBER and `meeting_guests.id` for a GUEST. BAL-131's webhook resolver and
 * BAL-134's presence writer must then route that value to `meeting_presence.user_id` vs
 * `meeting_presence.meeting_guest_id` — two columns held apart by the
 * `meeting_presence_identity_not_both` CHECK. BOTH IDS ARE UUIDS, so the raw value is
 * AMBIGUOUS: nothing in `0f7b1c2d-…` says which table it came from. Guessing is a
 * mis-attribution that lands in a billing clock.
 *
 * So the KIND is carried IN the claim:
 *
 *   member → `u` + `users.id` with hyphens stripped, lowercased          = 33 chars
 *   guest  → `g` + `meeting_guests.id` with hyphens stripped, lowercased = 33 chars
 *
 * ⚠ THE `u:` / `g:` PREFIX ON A FULL 36-CHAR UUID WAS REJECTED, and the reason is a hard
 * vendor bound rather than taste: that form is 38 characters and Daily documents `user_id`
 * with a **36-character maximum** — VERIFIED 2026-08-11 against
 * `https://docs.daily.co/reference/rest-api/meeting-tokens/config`, not assumed. 33 fits
 * under 36 with room to spare, and would still fit if the vendor ever widened the bound, so
 * the encoding is safe in both directions. {@link DAILY_PARTICIPANT_ID_MAX_LENGTH} records
 * the verified number, and a test asserts the output stays inside it.
 *
 * The hyphen-stripping mirrors `dailyRoomNameForMeeting` (`balo-` + 32 hex) deliberately, so
 * the two Daily-facing identifier formats this platform produces read the same way.
 *
 * ⚠⚠ A BARE UUID MUST NOT PARSE, AND THAT IS THE POINT OF THE WHOLE MODULE.
 * {@link parseDailyParticipantId} returns `null` for one — for a 36-char hyphenated uuid, for
 * a 32-char hex run, for an unknown tag, for uppercase hex. An unrecognised participant id
 * means "IDENTITY UNKNOWN", and `meeting_presence` explicitly permits a NULL identity beside
 * a known `party`. Returning a best guess would put a guest's presence on a member's row (or
 * the reverse) — the single failure mode this encoding exists to prevent — and a billing
 * clock would then be anchored on the wrong person. FAIL CLOSED: `null`, never a guess.
 *
 * ⚠ IT LIVES IN `@balo/shared/meetings`, NOT IN `apps/api`, for exactly the reason
 * `room-name.ts`'s docblock records for `dailyRoomNameForMeeting`: BAL-132's minter writes
 * this claim, BAL-131's webhook resolver reads it, and BAL-134's presence writer routes on
 * it. THREE consumers in two apps. A second definition of "how do I read a Daily participant
 * id" is how a diarization mis-attribution ships. PURE and dependency-free.
 */

/**
 * Daily's documented maximum for `user_id` on `POST /v1/meeting-tokens`.
 *
 * ⚠ VERIFIED, NOT ASSUMED (2026-08-11) —
 * `https://docs.daily.co/reference/rest-api/meeting-tokens/config`. The encoding below
 * produces 33 characters, so it is inside this bound with three to spare; if the vendor ever
 * publishes a different number, update THIS constant and the test that leans on it rather
 * than changing the encoding, which does not depend on the exact value.
 */
export const DAILY_PARTICIPANT_ID_MAX_LENGTH = 36;

/** The exact character count every id this module emits has. `1` tag + `32` hex. */
export const DAILY_PARTICIPANT_ID_LENGTH = 33;

/**
 * Which table the id came from — and therefore which `meeting_presence` column it belongs in.
 *
 * `user` → `meeting_presence.user_id`; `guest` → `meeting_presence.meeting_guest_id`. Never
 * both (`meeting_presence_identity_not_both`).
 */
export type DailyParticipantKind = 'user' | 'guest';

/** A decoded `user_id` claim: which kind, and the canonical hyphenated uuid. */
export interface DailyParticipantIdentity {
  readonly kind: DailyParticipantKind;
  /** Canonically hyphenated and lowercased — directly usable as a `WHERE id = $1` value. */
  readonly id: string;
}

/**
 * The one-character tag per kind.
 *
 * ⚠ A `Record<DailyParticipantKind, …>` so a THIRD kind (were one ever added) is a compile
 * error here rather than a silent fall-through to an untagged id.
 */
const KIND_TAG: Record<DailyParticipantKind, string> = {
  user: 'u',
  guest: 'g',
};

/** The inverse of {@link KIND_TAG}, keyed by tag. Absent tag ⇒ unknown kind ⇒ `null`. */
const TAG_KIND: Readonly<Record<string, DailyParticipantKind>> = {
  u: 'user',
  g: 'guest',
};

/**
 * ANCHORED, BOUNDED, AND WITH NO NESTED OR OVERLAPPING QUANTIFIER — deliberately written so
 * SonarCloud's S5852 (super-linear backtracking) cannot apply and so hostile input cannot
 * pin the event loop. One optional-free alternation of two literal characters, then an
 * EXACTLY-32 hex run, then end-of-string: linear, and it rejects on length before it can do
 * any work.
 *
 * ⚠ LOWERCASE HEX ONLY. Uppercase is refused rather than folded: this module EMITS
 * lowercase, so an uppercase claim did not come from here, and silently accepting it would
 * make "did we mint this?" unanswerable.
 */
const PARTICIPANT_ID_PATTERN = /^([ug])([0-9a-f]{32})$/;

/**
 * Encode one participant identity for a Daily meeting token's `user_id`.
 *
 * ⚠ TOTAL AND NON-THROWING, matching `dailyRoomNameForMeeting`'s discipline: it strips
 * hyphens and lowercases, and validates nothing. That is safe in the ONE direction that
 * matters — a malformed uuid in yields a string {@link parseDailyParticipantId} REJECTS, so
 * the failure surfaces downstream as "identity unknown" (the fail-closed answer) rather than
 * as a confident mis-attribution. Callers pass a real `users.id` / `meeting_guests.id` read
 * from the database, so the defensive branch is not a live path.
 */
export function dailyParticipantIdFor(kind: DailyParticipantKind, id: string): string {
  return `${KIND_TAG[kind]}${id.replace(/-/g, '').toLowerCase()}`;
}

/**
 * Decode a Daily `user_id` claim back to a kind plus a canonical uuid, or `null`.
 *
 * ⚠ `null` IS A REAL ANSWER, NOT AN ERROR PATH — it means "this participant is not one we
 * minted a claim for", which is the correct reading of an anonymous or vendor-generated
 * participant. See the module docblock: `meeting_presence` permits a NULL identity beside a
 * known `party`, so the caller has somewhere honest to put this.
 */
export function parseDailyParticipantId(value: string): DailyParticipantIdentity | null {
  const match = PARTICIPANT_ID_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  // `noUncheckedIndexedAccess` is on: narrow by destructure + guard, never with `!`. Both
  // groups are non-optional in the pattern, so this branch is unreachable — but the house
  // rule is a guard, and a guard is what keeps this compiling if the pattern ever changes.
  const [, tag, hex] = match;
  if (tag === undefined || hex === undefined) {
    return null;
  }
  const kind = TAG_KIND[tag];
  if (kind === undefined) {
    return null;
  }
  return { kind, id: hyphenate(hex) };
}

/** 32 hex digits → the canonical `8-4-4-4-12` uuid form. */
function hyphenate(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
