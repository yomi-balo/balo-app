import 'server-only';

import { captureHealthRepository, type CaptureHealthCursor } from '@balo/db';
import { CAPTURE_HEALTH_PAGE_SIZE, type CaptureHealthCategory } from '@balo/shared/capture-health';
import { TRANSCRIPT_SOURCE_WITHHELD_AFTER_MS } from '@balo/shared/admin-alerts';
import { buildCaptureHealthRow, type CaptureHealthRowView } from './capture-health-view';
import type { CaptureHealthWindowView } from './window';

/**
 * BAL-550 (§7.3) — the server-side loader behind `page.tsx`. ONE `now` and ONE
 * `withheldBefore`, computed once and carried into the cursor DTO, so a load-more page ranks
 * against the SAME instant the first page did (`captureHealthRepository.listPage`'s stability
 * argument).
 */

/** Over the wire to the client — ISO strings, never a `Date` (the `AdminQueueCursor` precedent,
 *  `admin-queue-view.ts`). */
export interface CaptureHealthCursorDTO {
  healthRank: number;
  scheduledStartIso: string;
  meetingId: string;
}

export interface CaptureHealthPageDTO {
  rows: readonly CaptureHealthRowView[];
  pinned: CaptureHealthRowView | null;
  /** `?row=` named a meeting id, but it resolved to no live row. */
  pinnedMissing: boolean;
  tiles: Record<CaptureHealthCategory, number>;
  hasMore: boolean;
  nextCursor: CaptureHealthCursorDTO | null;
  isTrueZero: boolean;
  window: { fromIso: string; toIso: string; days: number };
  category: CaptureHealthCategory | null;
  issueCount: number;
  /** The instant every rank in this page (and every subsequent load-more page) was computed
   *  against — carried by the client back into `loadMoreCaptureHealth`. */
  withheldBeforeIso: string;
}

function toCursorDTO(cursor: CaptureHealthCursor): CaptureHealthCursorDTO {
  return {
    healthRank: cursor.healthRank,
    scheduledStartIso: cursor.scheduledStart.toISOString(),
    meetingId: cursor.meetingId,
  };
}

export function fromCursorDTO(dto: CaptureHealthCursorDTO): CaptureHealthCursor {
  return {
    healthRank: dto.healthRank,
    scheduledStart: new Date(dto.scheduledStartIso),
    meetingId: dto.meetingId,
  };
}

function lastRowCursor(
  rows: readonly { meetingId: string; scheduledStart: Date; healthRank: number }[]
): CaptureHealthCursor | undefined {
  const last = rows[rows.length - 1];
  if (last === undefined) return undefined;
  return {
    healthRank: last.healthRank,
    scheduledStart: last.scheduledStart,
    meetingId: last.meetingId,
  };
}

export async function loadCaptureHealth(input: {
  window: CaptureHealthWindowView;
  category: CaptureHealthCategory | null;
  pinnedMeetingId: string | null;
}): Promise<CaptureHealthPageDTO> {
  const now = new Date();
  const withheldBefore = new Date(now.getTime() - TRANSCRIPT_SOURCE_WITHHELD_AFTER_MS);
  const window = { from: input.window.from, to: input.window.to };

  const [page, tiles, hasAnyRecording, pinnedRow] = await Promise.all([
    captureHealthRepository.listPage({
      window,
      category: input.category,
      withheldBefore,
      limit: CAPTURE_HEALTH_PAGE_SIZE,
    }),
    captureHealthRepository.countByCategory({ window, withheldBefore }),
    captureHealthRepository.hasAnyRecording(),
    input.pinnedMeetingId === null
      ? Promise.resolve(undefined)
      : captureHealthRepository.findByMeetingId({
          meetingId: input.pinnedMeetingId,
          withheldBefore,
        }),
  ]);

  const idsForDetails = [
    ...page.rows.map((r) => r.meetingId),
    ...(pinnedRow === undefined ? [] : [pinnedRow.meetingId]),
  ];
  const details = await captureHealthRepository.loadDetails(idsForDetails);

  const detailsFor = (meetingId: string) => ({
    recordings: details.recordings.get(meetingId) ?? [],
    recap: details.recap.get(meetingId),
    recapFailed: details.recapFailed.get(meetingId),
    expert: details.expert.get(meetingId),
    party: details.party.get(meetingId),
  });

  const rows = page.rows.map((row) =>
    buildCaptureHealthRow(row, detailsFor(row.meetingId), { now })
  );
  const pinned =
    pinnedRow === undefined
      ? null
      : buildCaptureHealthRow(pinnedRow, detailsFor(pinnedRow.meetingId), { now });

  // The pinned row is de-duplicated out of the list below (it renders in its own band).
  const dedupedRows = pinned === null ? rows : rows.filter((r) => r.meetingId !== pinned.meetingId);

  const issueCount = tiles.recording + tiles.transcription + tiles.recap;
  const cursor = lastRowCursor(page.rows);

  return {
    rows: dedupedRows,
    pinned,
    pinnedMissing: input.pinnedMeetingId !== null && pinnedRow === undefined,
    tiles,
    hasMore: page.hasMore,
    nextCursor: page.hasMore && cursor !== undefined ? toCursorDTO(cursor) : null,
    isTrueZero: !hasAnyRecording,
    window: { fromIso: input.window.fromIso, toIso: input.window.toIso, days: input.window.days },
    category: input.category,
    issueCount,
    withheldBeforeIso: withheldBefore.toISOString(),
  };
}
