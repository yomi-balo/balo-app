/**
 * BAL-546 — merge two id-keyed reads of the same set, KEEPING EACH ROW ONCE and preserving `id`
 * ordering. Shared by `projectRequestsRepository.close` (proposals AND relationships) and
 * `requestExpertRelationshipsRepository.declineTrack` (proposals only) so the dedupe rule lives
 * in exactly one place.
 *
 * ⚠ THE DEDUPE IS NOT TIDINESS — WITHOUT IT THE CLOSE THROWS. `advanceProposalStatus` is called
 * with no `expectedFrom` when withdrawing, and a terminal proposal status has an EMPTY transition
 * list, so advancing the SAME proposal twice raises `InvalidProposalTransitionError` and rolls
 * the entire close back — a correctness fix turned into an outage. The two reads (the pre-lock
 * snapshot and the post-lock re-read) overlap almost completely — the snapshot's rows are held
 * `FOR UPDATE`, so nothing can move them out of the open set before the re-read sees them again —
 * which is exactly why concatenation would double every row.
 *
 * ⚠ RELATIONSHIPS ARE ALREADY SAFE AND PROPOSALS ARE NOT — AN ASYMMETRY WORTH NAMING RATHER THAN
 * RELYING ON. `close()`'s relationship step skips a duplicate via `isAllowedRelationshipTransition
 * (declined → declined)` being false; the proposal step has no such guard. Both go through this
 * helper anyway, so the asymmetry cannot become load-bearing.
 *
 * `second`'s rows win no ties (a row present in both keeps `first`'s copy) — the two reads are of
 * the SAME committed data at different points in the same transaction, so the fields never
 * actually disagree; this is just which physical object survives the merge.
 */
export function unionById<T extends { id: string }>(
  first: readonly T[],
  second: readonly T[]
): T[] {
  const byId = new Map<string, T>();
  for (const row of first) {
    byId.set(row.id, row);
  }
  for (const row of second) {
    if (!byId.has(row.id)) {
      byId.set(row.id, row);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
