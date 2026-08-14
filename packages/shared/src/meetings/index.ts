/**
 * Meeting clocks (BAL-418 / ADR-1045 §6; BAL-134 owns the WRITES that produce the input).
 *
 * Two clocks fall out of `meeting_presence`'s per-interval rows:
 *
 *   expertPresentMs = last expert presence − FIRST expert join                 (gap-inclusive)
 *   billableMs      = last instant both sides present − FIRST such instant     (gap-inclusive)
 *
 * ⚠ BOTH CLOCKS ARE SPANS, NOT SUMS. A drop+rejoin adds a second interval but does NOT
 * move the first-join anchor and does NOT restart the timer — the span is unchanged and
 * the gap sits INSIDE it. That is BAL-134's "rejoins must not fragment the duration or
 * restart the billable timer". `SUM(left − joined)` would silently SHORTEN a call for
 * every network blip, i.e. under-bill.
 *
 * ⚠ AND THE SAME CHOICE CUTS THE OTHER WAY — STATED EXPLICITLY SO NOBODY DISCOVERS IT VIA
 * AN INVOICE. Gap-inclusive means a gap of ANY size is inside the span. On a 60-minute
 * call with the expert present throughout, a client present 2→4 min and again 58→60 min
 * yields `billableMs = 58 min` — the SPAN 2→60 — NOT the 4 min a sum-of-intervals would
 * give. (The anchor is the FIRST both-present instant, not the call start: had that client
 * instead joined at minute 0, the span would be the full 60.) That IS the intended
 * semantics: the expert held the slot for the whole hour, and a rule that pauses billing
 * during a gap is precisely the rule a party could exploit by dropping. But it is a real
 * exposure at the long end, and a PURE function is the wrong place for policy — it reports
 * the span faithfully and caps nothing. Both numbers are PINNED by tests in `index.test.ts`
 * so this paragraph cannot drift from the behaviour.
 *
 * ⚠ THE POLICY CAP IS ASSIGNED: **BAL-412** (settlement) holds it and already carries
 * `effectiveCeilingMinor` as the money-side backstop; **BAL-134** clamps presence to the
 * meeting window on the write side.
 *
 * `observer` (a Balo staffer / silent attendee) is present but NEVER makes a meeting
 * billable — it is excluded from the billable intersection by construction.
 *
 * PURE and dependency-free (no `@balo/db`, no I/O) — the `@balo/shared/engagements`
 * precedent — so BAL-403's in-session client panel can render the clocks without the
 * `@balo/db` client-bundle footgun (memory `reference_balo_db_client_bundle_footgun`).
 */

// BAL-129 — the other three members of this subpath. All PURE and dependency-free for the
// same reason the clocks are: `apps/api` (booking + provisioning), `@balo/analytics`,
// `@balo/db`'s webhook resolver consumers and an `apps/web` join surface must all reach ONE
// definition without value-importing `@balo/db`.
//
// ⚠⚠ **NO `.js` EXTENSIONS ON RELATIVE IMPORTS IN `packages/shared`. EVER.** (Corrected by
// BAL-134 — the paragraph that stood here was FALSE and was a live trap sitting directly above
// the lines this ticket edits.)
//
// The old text claimed "EXPLICIT `.js` EXTENSIONS … an extensionless relative specifier is
// TS2835". Every re-export below it was, and still is, EXTENSIONLESS — so the comment
// described the opposite of the code, and following it would have been actively harmful:
// `@balo/shared`'s `exports` map points at RAW `./src/*.ts`, so a `./foo.js` specifier resolves
// to a file that does not exist. Turbopack answers 404 and `next build`, the E2E job and the
// Vercel deploy all die while `tsc`, `eslint` and `vitest` stay green (memory
// `reference_balo_shared_no_js_extensions_in_reexports`).
//
// ⚠ `apps/api` HAS THE **OPPOSITE** RULE — it compiles to real ESM and its relative imports DO
// carry `.js`. Follow what each package actually does; the two are not interchangeable.
export * from './bookable-contexts';
export * from './bounds';
export * from './room-name';
// BAL-132 — the Daily `user_id` claim's encoding, beside `room-name` and for the SAME
// reason: this ticket's token minter WRITES it, BAL-131's webhook resolver READS it, and
// BAL-134's presence writer ROUTES on it (`user_id` vs `meeting_guest_id`). Two apps, three
// consumers, one definition — a second one is how a diarization mis-attribution ships.
export * from './participant-identity';
// BAL-408 — the guest participation model's pure core (the meetingId→context combining
// rule, THE MONEY RULE, the retrospective read predicate, counterparty concealment).
export * from './guest-participation';
// BAL-423 — the ONE definition of "who owns this meeting context", as a pure rule over
// INJECTED reads. `apps/api`'s gate and `@balo/db`'s repository wrapper both delegate to it,
// which is what stops the mapping existing twice. Pure by construction: no `@balo/db`
// import, and deliberately NO `server-only` (that subpath crash-loops `apps/api`'s tsup
// bundle — the PR #191 hazard).
export * from './context-owner';
// BAL-132 — the join CREDENTIAL's shape, so `apps/api` (which produces it) and `apps/web`
// (which consumes it and spreads it into `MeetingCallSurface`'s props) cannot drift. It was
// previously declared twice and linked by a COMMENT; BAL-435 builds against this one.
export * from './join-grant';
// BAL-436 — the ONE address scan and the ONE self-declared-name reduction. `apps/api`'s
// PUBLIC lobby route runs it at the knock (before the row is written) and `apps/web`'s
// concealment sweeps import the same scan, so a weakening cannot pass one and fail the other.
export * from './self-declared-name';
// BAL-134 — the five lifecycle timers as typed defaults. ⚠ NO `process.env` in there: this
// subpath is client-reachable, and the env-override reader lives in `apps/api` alone (D8).
export * from './timers';
// BAL-134 / ADR-1049 — the lifecycle's pure core: the legal-edge map, the four SYSTEM terminal
// rules and their disjointness, and the SERVER-computed waiting phase. Reads no clock.
export * from './lifecycle';
// BAL-134 (D3) — `canEndMeeting`, the SIXTH `JoinGrant` field. ⚠ Read that module's first
// paragraph before touching either boolean: merging it into `isOwner` mints DAILY OWNER TOKENS
// FOR CLIENTS.
export * from './end-authority';

import type { MeetingPresenceParty } from './guest-participation';

/** One `meeting_presence` row, reduced to what the clocks need. */
export interface PresenceInterval {
  /**
   * ⚠ BAL-408: a GUEST's row must derive this through `presencePartyForGuest`, never from
   * the guest's own `party` column — an expert-side guest written as `'expert'` would put a
   * NON-DELIVERING attendee on the billable clock below. See THE MONEY RULE.
   *
   * ⚠ BAL-132 WIDENED THAT OBLIGATION, AND THE SIGNATURE NOW ENFORCES IT: the derivation
   * takes the guest's `invite_channel` TOO, non-optionally, because a `link`-channel row's
   * `party` is a self-declared PLACEHOLDER rather than a resolved side and maps to
   * `observer` regardless of what is stored. Passing only the party no longer compiles.
   */
  party: MeetingPresenceParty;
  joinedAt: Date;
  /** `null` = still present at `now`. */
  leftAt: Date | null;
}

export interface MeetingClocks {
  /** Span from the FIRST expert join to the last expert presence. Gap-inclusive. */
  expertPresentMs: number;
  /**
   * Span from the FIRST instant the expert AND ≥1 client were both present, to the last
   * such instant. Gap-inclusive.
   */
  billableMs: number;
  /** `null` when no expert ever joined. */
  expertFirstJoinedAt: Date | null;
  /** `null` when the expert and a client were never in the room together. */
  billableStartedAt: Date | null;
}

/** A half-closed-in-spirit but CLOSED-in-arithmetic presence span, in epoch ms. */
interface Span {
  start: number;
  end: number;
}

/**
 * Project one party's intervals onto closed epoch-ms spans. An OPEN interval
 * (`leftAt === null`) runs to `now`.
 *
 * ⚠ AN INTERVAL WITH A NON-FINITE ENDPOINT IS SKIPPED ENTIRELY — not clamped, not
 * zero-lengthed. An Invalid `joinedAt`/`leftAt` (or an Invalid `now` closing an open
 * interval) yields NaN, and NaN has NO POSITION ON THE TIMELINE: it cannot be ordered.
 * Left in, it reaches `merge`'s `(a, b) => a.start - b.start` as an INCONSISTENT
 * COMPARATOR — every comparison involving it returns NaN, which the sort reads as "not
 * greater than zero", so the corrupt element keeps whatever position the CALLER's array
 * gave it. The merged spans, and therefore the clocks of the VALID rows around it, then
 * depend on INPUT ORDER. Executed over all six orderings of the three-interval scenario in
 * `index.test.ts`: with this guard removed, three orderings return `expertPresentMs =
 * 20 min / billableMs = 10 min` and the other three return `NaN / 0`. SO WHAT THE GUARD
 * BUYS IS DETERMINISM PLUS A NON-NaN RESULT — not the avoidance of one particular wrong
 * number. A zero-length span at an unknown instant would be meaningless anyway, so the row
 * contributes nothing at all.
 *
 * DEFENSIVE — BUT NOT FOR THE REASON AN EARLIER DRAFT OF THIS BLOCK GAVE. It claimed the
 * columns are `timestamp NOT NULL` "so Postgres cannot hand us an Invalid Date". That is
 * false twice over: `NOT NULL` governs NULL, not validity, and Postgres REPRESENTS instants
 * JavaScript cannot. Round-tripped through Postgres 16 + postgres-js 3.4.8, `'infinity'`,
 * `'-infinity'`, `'294276-12-31 23:59:59+00'` (pg's max) and `'4713-01-01 BC'` (pg's min)
 * EVERY ONE parses to an Invalid Date — `getTime()` is NaN — while `'275760-09-12'`, just
 * inside JS's ±8.64e15 ms range, parses finite. Nor does the CHECK
 * `meeting_presence_left_after_joined` stop it: `left_at = 'infinity'` is ACCEPTED, because
 * `infinity >= joined_at` is TRUE in Postgres.
 *
 * WHAT ACTUALLY KEEPS IT OFF THE LIVE PATH IS THE WRITE SIDE, at the driver. postgres-js
 * serializes a bind parameter as `(x instanceof Date ? x : new Date(x)).toISOString()`,
 * which THROWS `RangeError: Invalid time value` on an Invalid Date (and Postgres itself
 * rejects a JS-max `Date` with `time zone displacement out of range`). So
 * `meetingPresenceRepository.open()`/`close()` structurally CANNOT WRITE such a value —
 * only raw SQL, a manual operator action, or a future non-Drizzle writer could. The
 * conclusion ("defensive, not a live path") survives and is better founded than the claim
 * it replaces. The other reachable source is this module's own client-bundle surface
 * (`@balo/shared/meetings`, for BAL-403's in-session panel), where a caller constructs
 * `Date`s with no driver in the way at all.
 *
 * ⚠ THE RESIDUAL, STATED RATHER THAN HIDDEN: an Invalid `now` makes EVERY still-open
 * interval non-finite, so the guard drops them ALL and returns a plausible FINITE number
 * where the pre-guard code returned NaN — a loud failure traded for a quiet wrong one. Not
 * reachable in production (`resolveClockCeiling` supplies `meetings.ended_at` or
 * `new Date()`), and PINNED by a test in `index.test.ts` so it cannot become a surprise.
 *
 * ⚠ SURFACING A DROPPED INTERVAL IS THE CALLER'S OBLIGATION, ASSIGNED IN WRITING — this is
 * a PURE function: it cannot log, and throwing on a billing read is worse than dropping an
 * uninterpretable row. **BAL-134** (which writes presence) must reject a non-finite
 * timestamp at the webhook write seam; **BAL-412** (which settles) must not settle on
 * intervals it did not verify. Same assignment as the window-clamp and policy-cap
 * obligations stated at the top of this file.
 */
function toSpans(
  intervals: readonly PresenceInterval[],
  party: PresenceInterval['party'],
  nowMs: number
): Span[] {
  const spans: Span[] = [];
  for (const interval of intervals) {
    if (interval.party !== party) {
      continue;
    }
    const start = interval.joinedAt.getTime();
    const rawEnd = interval.leftAt === null ? nowMs : interval.leftAt.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(rawEnd)) {
      continue;
    }
    // The finite guard above is what makes `Math.max` safe here — with both operands
    // finite it cannot propagate NaN, so it is exactly a clamp of `end` up to `start`. It
    // degrades a still-future open interval, or a malformed `leftAt < joinedAt` row that
    // the DB CHECK `meeting_presence_left_after_joined` already rejects (so this too is
    // defensive), to a ZERO-LENGTH span rather than a negative one.
    spans.push({ start, end: Math.max(start, rawEnd) });
  }
  return spans;
}

/**
 * Sort + coalesce overlapping OR touching spans into a disjoint, ascending list. Touching
 * spans merge (`next.start <= current.end`): leaving and instantly rejoining is one
 * continuous presence, not two.
 */
function merge(spans: Span[]): Span[] {
  if (spans.length === 0) {
    return [];
  }
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const current = merged.at(-1);
    if (current === undefined || span.start > current.end) {
      merged.push({ start: span.start, end: span.end });
      continue;
    }
    if (span.end > current.end) {
      current.end = span.end;
    }
  }
  return merged;
}

/**
 * Two-pointer intersection of two DISJOINT ASCENDING span lists. Overlap is CLOSED
 * (`start <= end` on both sides), so a zero-length blip — both sides present for a single
 * instant — is a real intersection that yields `billableMs = 0` rather than being dropped.
 */
function intersect(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a[i];
    const right = b[j];
    if (left === undefined || right === undefined) {
      break;
    }
    const start = Math.max(left.start, right.start);
    const end = Math.min(left.end, right.end);
    if (start <= end) {
      out.push({ start, end });
    }
    if (left.end < right.end) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return out;
}

/** The gap-inclusive span of a disjoint ascending list: `last.end − first.start`. */
function spanOf(spans: readonly Span[]): { startMs: number; durationMs: number } | null {
  const first = spans[0];
  const last = spans.at(-1);
  if (first === undefined || last === undefined) {
    return null;
  }
  return { startMs: first.start, durationMs: last.end - first.start };
}

/**
 * Compute both meeting clocks from a meeting's LIVE presence intervals.
 *
 * `now` closes any still-open interval (`leftAt === null`), so an in-progress meeting
 * reports the clocks as at that instant. Order of `intervals` is irrelevant.
 */
export function computeMeetingClocks(intervals: PresenceInterval[], now: Date): MeetingClocks {
  const nowMs = now.getTime();

  const expert = merge(toSpans(intervals, 'expert', nowMs));
  const client = merge(toSpans(intervals, 'client', nowMs));

  const expertSpan = spanOf(expert);
  // `observer` is deliberately absent from BOTH sides of this intersection.
  const billableSpan = spanOf(intersect(expert, client));

  return {
    expertPresentMs: expertSpan?.durationMs ?? 0,
    billableMs: billableSpan?.durationMs ?? 0,
    expertFirstJoinedAt: expertSpan === null ? null : new Date(expertSpan.startMs),
    billableStartedAt: billableSpan === null ? null : new Date(billableSpan.startMs),
  };
}
