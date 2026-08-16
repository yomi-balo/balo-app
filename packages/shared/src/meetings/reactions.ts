/**
 * BAL-437 — the in-call REACTION vocabulary. ⚠⚠ **PURE: NO IMPORTS, NO I/O, NO REACT.**
 *
 * ── ⚠⚠ WHY IT LIVES IN `@balo/shared` AND NOT IN `apps/web` ──────────────────────────────
 *
 * It has TWO consumers in two packages that cannot import each other: `apps/web` (the picker,
 * the Zod `z.enum` on the Server Action, the inbound payload guard) and `@balo/analytics` (the
 * `emoji` property on `meeting_panel_reaction_sent`). `@balo/analytics` does not depend on
 * `apps/web` — the dependency runs one way only — so while the set lived in `apps/web` the
 * analytics package HAND-RESTATED it as a string union. Two definitions of one closed set is
 * exactly the shape CLAUDE.md forbids ("one definition in the owning package"), and the drift
 * it invites is silent: adding a seventh emoji in one place and not the other typechecks on
 * both sides until somebody reads a PostHog breakdown that is missing a bucket.
 *
 * ⚠ IT IS PURE AND DEPENDENCY-FREE, deliberately, and for the reason the rest of this subpath
 * is: `apps/web` reaches it from a `'use client'` island, so a transitive `@balo/db` import
 * here would be the client-bundle footgun (`reference_balo_db_client_bundle_footgun`).
 *
 * ── ⚠⚠ WHY THIS IS A TypeScript CONST AND **NOT** A pgEnum ──────────────────────────────
 *
 * A reaction is EPHEMERAL by acceptance criterion: it is never written to the meeting record,
 * never to the recap, never anywhere. Nothing persists it, so nothing in the database may
 * constrain it — a pgEnum would be a column's vocabulary with no column, and the next reader
 * would reasonably assume a table existed.
 *
 * ⚠ THE SIX ARE AN ACCEPTANCE CRITERION, NOT A PREFERENCE. There is deliberately **no 👎 and
 * no 😢** — this is a paid consultation between a client and an expert, and a one-tap
 * anonymous downvote floating over somebody's face is a product decision nobody made. Adding
 * one is a product change, not a constant edit.
 */

/** The closed set, in the order the picker renders them. */
export const MEETING_REACTIONS = ['👍', '👏', '❤️', '🎉', '😂', '😮'] as const;

export type MeetingReactionEmoji = (typeof MEETING_REACTIONS)[number];

/** Is `value` one of the six? A plain `includes` over the closed set. */
export function isMeetingReactionEmoji(value: unknown): value is MeetingReactionEmoji {
  return typeof value === 'string' && (MEETING_REACTIONS as readonly string[]).includes(value);
}
