/**
 * THE client-visibility rule for a request's expert tracks.
 *
 * A client sees, counts, names and interacts with an expert only once that expert's track has
 * OPENED — the expert submitted an EOI (a direct request's expert gets one automatically), or
 * Balo requested a proposal from them. Before that the expert is invisible to the client, and a
 * track declined before it opened stays invisible for good.
 *
 * The fact is the stamped `request_expert_relationships.opened_at` column, never `status`:
 * `declined` erases whether the track had opened. Every client-facing reader resolves through
 * this one predicate.
 *
 * PURE. No I/O, no clock.
 */

/** The one column the rule reads. Structural; the Drizzle relationship row satisfies it. */
export interface RelationshipOpenedFact {
  readonly openedAt: Date | null;
}

/**
 * True once the track has opened — the client may see and interact with this expert.
 *
 * ⚠ FAILS CLOSED. `!= null` (not `!== null`) so a projection that forgot the column — `openedAt`
 * reading `undefined` — hides the expert rather than revealing them.
 */
export function relationshipIsOpened(track: RelationshipOpenedFact): boolean {
  return track.openedAt != null;
}
