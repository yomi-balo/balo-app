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
 * AN INVOICE. Gap-inclusive means a gap of ANY size is inside the span. A client present
 * 0→2 min and again 58→60 min of a 60-minute call yields `billableMs = 58 min`, NOT 4.
 * That IS the intended semantics: the expert held the slot for the whole hour, and a rule
 * that pauses billing during a gap is precisely the rule a party could exploit by
 * dropping. But it is a real exposure at the long end, and a PURE function is the wrong
 * place for policy — it reports the span faithfully and caps nothing.
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

/** One `meeting_presence` row, reduced to what the clocks need. */
export interface PresenceInterval {
  party: 'expert' | 'client' | 'observer';
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
 * (`leftAt === null`) runs to `now`. `end` is clamped to `start` so a still-future open
 * interval, or a malformed `leftAt < joinedAt` row the DB CHECK would have rejected,
 * degrades to a zero-length span instead of a negative one.
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
    // DO NOT "simplify" this ternary to Math.max(start, rawEnd). SonarCloud S6836 suggests
    // it; the two are NOT equivalent on this billing path. An Invalid Date makes `start`
    // NaN: the ternary keeps the finite `rawEnd`, Math.max propagates NaN. NaN then poisons
    // the sort comparator in `mergeSpans`, so the corrupt row need not sort first and a
    // *different finite* first.start survives — measured as a silent 40-minute swing in
    // billableMs (50min vs 10min) with no NaN downstream for BAL-412 settlement to catch.
    // Clamping instead of maxing keeps a garbage row zero-length rather than contagious.
    spans.push({ start, end: rawEnd < start ? start : rawEnd });
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
