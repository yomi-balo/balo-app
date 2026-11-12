import { MAX_GALLERY_CELLS } from './gallery-grid';

/**
 * BAL-435 — WHO GETS A TILE, AND IN WHAT ORDER. Pure, so the rule is testable without a room.
 *
 * ⚠ ORDER: screen-sharer → remotes by join time → **self LAST**.
 * Self is in-grid in gallery and is never ALSO a picture-in-picture.
 *
 * ⚠⚠ THE ACTIVE SPEAKER DOES NOT MOVE. Speaking is shown by the tile's highlight, in place. Ranking
 * the speaker first sent their tile sliding to the top-left (the gallery animates `layout`)
 * every time someone new spoke, so the whole grid lurched through a normal conversation.
 *
 * ⚠⚠ ABOVE THE CAP, EVERYONE'S AUDIO STILL PLAYS. This function decides TILES, never audio.
 * `MAX_MEETING_PARTICIPANTS` is app-side and soft — its own docblock concedes an 11th can be
 * committed, and the cap is never passed to Daily — so this UI cannot refuse a join. It renders
 * the first nine and collapses the rest into one overflow tile, and a REMOTE ACTIVE SPEAKER IS
 * ALWAYS PROMOTED OUT OF OVERFLOW — into the LAST visible cell, so no other tile moves.
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

function rankOf(candidate: TileCandidate): 0 | 1 | 2 {
  // ⚠ SELF IS LAST: you already know where you are, and it is never promoted for speaking.
  if (candidate.isLocal) return 2;
  if (candidate.isScreenSharing) return 0;
  return 1;
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
    const rankDelta = rankOf(a) - rankOf(b);
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
  const visible = sorted.slice(0, MAX_GALLERY_CELLS - 1);
  const overflow = sorted.slice(MAX_GALLERY_CELLS - 1);

  const speakerIndex = overflow.findIndex(
    (candidate) => candidate.sessionId === activeSpeakerId && !candidate.isLocal
  );
  const displaced = visible.at(-1);
  if (speakerIndex === -1 || displaced === undefined) {
    return { visible, overflow };
  }
  // ⚠ A SWAP INTO THE LAST CELL, never a re-sort: the eight tiles before it stay exactly where
  // they were, and the displaced tile goes back to its own place in the (still sorted) overflow.
  const speaker = overflow[speakerIndex];
  if (speaker === undefined) {
    return { visible, overflow };
  }
  return {
    visible: [...visible.slice(0, -1), speaker],
    overflow: [displaced, ...overflow.filter((_candidate, index) => index !== speakerIndex)],
  };
}
