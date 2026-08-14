import { MAX_GALLERY_CELLS } from './gallery-grid';

/**
 * BAL-435 — WHO GETS A TILE, AND IN WHAT ORDER. Pure, so the rule is testable without a room.
 *
 * ⚠ ORDER: active speaker → screen-sharer → remotes by join time → **self LAST**.
 * Self is in-grid in gallery and is never ALSO a picture-in-picture.
 *
 * ⚠⚠ ABOVE THE CAP, EVERYONE'S AUDIO STILL PLAYS. This function decides TILES, never audio.
 * `MAX_MEETING_PARTICIPANTS` is app-side and soft — its own docblock concedes an 11th can be
 * committed, and the cap is never passed to Daily — so this UI cannot refuse a join. It renders
 * the first nine and collapses the rest into one overflow tile, and the ACTIVE SPEAKER IS ALWAYS
 * PROMOTED OUT OF OVERFLOW.
 */

export interface TileCandidate {
  /** Daily's `session_id`. ⚠ The React key — never an array index (S6479). */
  readonly sessionId: string;
  readonly isLocal: boolean;
  readonly isScreenSharing: boolean;
  /** Epoch ms. Ties are broken by `sessionId` so the order is STABLE across renders. */
  readonly joinedAtMs: number;
}

export interface OrderedTiles {
  /** The tiles that get a real cell, already in render order. */
  readonly visible: readonly TileCandidate[];
  /** Everyone collapsed into the overflow tile. ⚠ Their audio is unaffected. */
  readonly overflow: readonly TileCandidate[];
}

function rankOf(candidate: TileCandidate, activeSpeakerId: string | null): 0 | 1 | 2 | 3 {
  // ⚠ SELF IS LAST EVEN WHEN SELF IS THE ACTIVE SPEAKER: a grid that reshuffles every time you
  // clear your throat is unusable, and you already know where you are.
  if (candidate.isLocal) return 3;
  if (candidate.sessionId === activeSpeakerId) return 0;
  if (candidate.isScreenSharing) return 1;
  return 2;
}

/**
 * Order the room, and split it at the cap.
 *
 * ⚠ `MAX_GALLERY_CELLS - 1` REAL TILES WHEN THERE IS AN OVERFLOW, so the overflow tile itself
 * occupies the tenth cell and the grid class still matches the cell count.
 */
export function orderTiles(
  candidates: readonly TileCandidate[],
  activeSpeakerId: string | null
): OrderedTiles {
  const sorted = [...candidates].sort((a, b) => {
    const rankDelta = rankOf(a, activeSpeakerId) - rankOf(b, activeSpeakerId);
    if (rankDelta !== 0) return rankDelta;
    const joinDelta = a.joinedAtMs - b.joinedAtMs;
    if (joinDelta !== 0) return joinDelta;
    // ⚠ A TOTAL ORDER, ALWAYS. An inconsistent comparator lets equal elements keep whatever
    // position the caller's array gave them, so the grid would reshuffle on every render.
    return a.sessionId.localeCompare(b.sessionId);
  });

  if (sorted.length <= MAX_GALLERY_CELLS) {
    return { visible: sorted, overflow: [] };
  }
  return {
    visible: sorted.slice(0, MAX_GALLERY_CELLS - 1),
    overflow: sorted.slice(MAX_GALLERY_CELLS - 1),
  };
}
