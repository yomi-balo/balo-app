import 'server-only';

import { expertsRepository } from '@balo/db';
import { deriveSessionEstimate } from '@balo/shared/credit';
import { CALL_NOW_SCHEDULED_MINUTES } from '@balo/shared/meetings';
import { formatAud } from '@/lib/credit/display-constants';
import { errorMessage, log } from '@/lib/logging';
import { CALL_NOW_COPY } from './call-now-copy';

/**
 * `From A$x.xx/min · 15-minute minimum` for an expert, or `null` when there is no rate to quote or
 * the read failed (the surface then simply shows no rate).
 *
 * ⚠ ONE ESTIMATOR. The client rate is the expert's raw rate marked up by `deriveSessionEstimate`,
 * the same derivation the session itself opens with, so the figure quoted is the figure billed. It
 * is "From" pricing: the starting rate for the first minutes, never a promise of a total.
 */
export async function readCallNowRateLine(expertProfileId: string): Promise<string | null> {
  try {
    const row = await expertsRepository.findRateCentsById(expertProfileId);
    const rateCents = row?.rateCents ?? null;
    if (rateCents === null || rateCents <= 0) return null;
    const { clientRateMinorPerMinute } = deriveSessionEstimate({
      expertRateMinorPerMinute: rateCents,
      estimatedMinutes: CALL_NOW_SCHEDULED_MINUTES,
    });
    return CALL_NOW_COPY.rateLine(formatAud(clientRateMinorPerMinute));
  } catch (error) {
    log.warn('Call now rate read failed — no rate shown', {
      expertProfileId,
      error: errorMessage(error),
    });
    return null;
  }
}
