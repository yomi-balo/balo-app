'use server';

import 'server-only';

import { captureHealthRepository } from '@balo/db';
import { CAPTURE_HEALTH_PAGE_SIZE, type CaptureHealthCategory } from '@balo/shared/capture-health';
import { TRANSCRIPT_SOURCE_WITHHELD_AFTER_MS } from '@balo/shared/admin-alerts';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { buildCaptureHealthRow } from '../_lib/capture-health-view';
import { parseCaptureHealthWindow } from '../_lib/window';
import { fromCursorDTO, type CaptureHealthCursorDTO } from '../_lib/load-capture-health';
import {
  loadMoreCaptureHealthSchema,
  type LoadMoreCaptureHealthResult,
} from './capture-health-schema';

const PERMISSION_DENIED = 'You do not have permission to do this.';
const GENERIC_FAILURE = 'Could not load more. Try again in a moment.';

/**
 * BAL-550 (§7.6) — the capture-health lens's keyset "Load more", a READ-ONLY Server Action.
 * Mirrors `loadMoreAdminAlerts` exactly.
 *
 * Gated on `VIEW_PLATFORM_ADMIN` (reachability), NOT `REDRIVE_JOB` — reading the lens does not
 * need the mutation token. Never on `READ_ONLY_ALLOWLIST` (that register is the bare-
 * `requireUser()` exception, which this does not want).
 *
 * ⚠⚠ EVERY TIME-BOUND HERE IS CLIENT-SUPPLIED AND IS RE-CLAMPED SERVER-SIDE. The three inputs
 * that reach SQL — `fromIso`, `toIso`, `withheldBeforeIso` — arrive from the browser; the
 * capability check only says the caller may READ the lens, and a platform `admin` who cannot
 * even re-drive can call this. Neither is bounded by the row `LIMIT`, because
 * `captureHealthRepository.listPage` runs three GROUPED AGGREGATE sub-queries over the window
 * before the keyset trims it:
 *   - the SPAN goes through {@link parseCaptureHealthWindow}, the same clamp page 1 applies,
 *     and this action uses ITS `from`/`to`. It never re-derives the half-open `+1d` bound; a
 *     second copy of that arithmetic is a second thing to keep in step.
 *   - `withheldBeforeIso` is clamped to at most `now − TRANSCRIPT_SOURCE_WITHHELD_AFTER_MS`. A
 *     LATER instant would let a caller declare every in-flight transcription "withheld" and
 *     re-rank the whole lens; an EARLIER one is exactly what page-to-page stability needs (the
 *     first page's instant recedes as the session goes on), so only the ceiling is enforced.
 */
export async function loadMoreCaptureHealth(input: {
  cursor: CaptureHealthCursorDTO;
  fromIso: string;
  toIso: string;
  category: CaptureHealthCategory | null;
  withheldBeforeIso: string;
}): Promise<LoadMoreCaptureHealthResult> {
  const user = await getCurrentUser();
  if (!user) {
    return { success: false, error: PERMISSION_DENIED };
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    return { success: false, error: PERMISSION_DENIED };
  }

  const parsed = loadMoreCaptureHealthSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: GENERIC_FAILURE };
  }
  const { cursor, fromIso, toIso, category, withheldBeforeIso } = parsed.data;

  try {
    // ONE definition of the window, clamp included — `toIso` names the LAST included day and
    // `parseCaptureHealthWindow` owns the half-open `+1d` bound, the inversion fallback and the
    // `CAPTURE_HEALTH_MAX_WINDOW_DAYS` cap.
    const parsedWindow = parseCaptureHealthWindow({ from: fromIso, to: toIso });
    const readWindow = { from: parsedWindow.from, to: parsedWindow.to };
    const withheldCeiling = Date.now() - TRANSCRIPT_SOURCE_WITHHELD_AFTER_MS;
    const withheldBefore = new Date(
      Math.min(new Date(withheldBeforeIso).getTime(), withheldCeiling)
    );

    const page = await captureHealthRepository.listPage({
      window: readWindow,
      category,
      withheldBefore,
      after: fromCursorDTO(cursor),
      limit: CAPTURE_HEALTH_PAGE_SIZE,
    });

    const meetingIds = page.rows.map((r) => r.meetingId);
    const details = await captureHealthRepository.loadDetails(meetingIds);
    const now = new Date();

    const rows = page.rows.map((row) =>
      buildCaptureHealthRow(
        row,
        {
          recordings: details.recordings.get(row.meetingId) ?? [],
          recap: details.recap.get(row.meetingId),
          recapFailed: details.recapFailed.get(row.meetingId),
          expert: details.expert.get(row.meetingId),
          party: details.party.get(row.meetingId),
        },
        { now }
      )
    );

    const [lastRow] = page.rows.slice(-1);
    const nextCursor: CaptureHealthCursorDTO | null =
      page.hasMore && lastRow !== undefined
        ? {
            healthRank: lastRow.healthRank,
            scheduledStartIso: lastRow.scheduledStart.toISOString(),
            meetingId: lastRow.meetingId,
          }
        : null;

    return { success: true, rows, hasMore: page.hasMore, nextCursor };
  } catch (error) {
    log.error('Failed to load more capture health rows', {
      actorUserId: user.id,
      category,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE };
  }
}
