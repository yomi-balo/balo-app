/**
 * BAL-399 (ADR-1040 / ADR-1043) — the EXTERNAL duration finalizer, i.e. the CONSUMER seam BAL-133
 * calls once a bot-fail / outside-tool consultation's duration is confirmed / disputed / auto-
 * confirmed. BAL-399 owns this consumer + the internal route; BAL-133 owns the confirm/dispute
 * producer + the `meeting.duration_confirm_*` chain (NOT duplicated here).
 *
 * Idempotent: a no-op unless the session is `external` and not yet finalized. On the live path it
 * draws the FULL confirmed minutes with NO ceiling clamp (Owner Decision 3 — `applyExternalDuration`),
 * then REUSES `endSessionAsSystem` (which runs `end()` → `settleOverdraft` → `finalizeBilling`) with
 * the recap-facing finalization `path`. Overflow settles to the mandate off-session or opens a
 * receivable + dunning if no mandate — BAL-378's machinery verbatim.
 */
import {
  creditSessionsRepository,
  ExternalDurationConflictError,
  type CreditFinalizationPath,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { endSessionAsSystem } from './end-session.js';
import type { EndSessionServiceResult } from './types.js';

const log = createLogger('credit-session');

/** The path a BAL-133 confirmation resolved to (never `live_capture` — that's the wall-clock path). */
export type ExternalFinalizationPath = Extract<
  CreditFinalizationPath,
  'confirmed' | 'disputed' | 'auto_confirmed'
>;

export interface DurationSettledInput {
  sessionId: string;
  /** The confirmed billable minutes (drawn in full, no ceiling clamp). */
  minutes: number;
  path: ExternalFinalizationPath;
  /** The confirming actor (BAL-133 audit context; not used for authorization here). */
  settledByUserId?: string;
}

/**
 * Apply a BAL-133-confirmed external duration and finalize the session. Returns the terminal
 * settlement outcome (like `endSessionAsSystem`). A replay after finalization is a logged no-op.
 */
export async function finalizeExternalDuration(
  input: DurationSettledInput
): Promise<EndSessionServiceResult> {
  const session = await creditSessionsRepository.findById(input.sessionId);
  if (session === undefined) {
    log.warn(
      { sessionId: input.sessionId },
      'finalizeExternalDuration — session not found (no-op)'
    );
    return { settlementStatus: 'not_required', overdraftSettledMinor: 0 };
  }

  // Idempotent guard: only an `external` session that has not already finalized is actionable.
  if (session.durationSource !== 'external' || session.billingFinalizedAt !== null) {
    log.warn(
      {
        sessionId: session.id,
        durationSource: session.durationSource,
        alreadyFinalized: session.billingFinalizedAt !== null,
      },
      'finalizeExternalDuration — already finalized or not external (no-op replay)'
    );
    return {
      settlementStatus: session.settlementStatus,
      overdraftSettledMinor: session.overdraftSettledMinor ?? 0,
    };
  }

  try {
    // Draw the full confirmed minutes (idempotent tick posting), then reuse end() + settlement.
    await creditSessionsRepository.applyExternalDuration(input.sessionId, input.minutes);
    return await endSessionAsSystem(input.sessionId, { finalizationPath: input.path });
  } catch (error) {
    // A conflicting second confirmation (different minutes) is EXPECTED control flow — the in-lock
    // guard already prevented a double-draw. Surface it (route → 409) without a Sentry-level error.
    if (error instanceof ExternalDurationConflictError) {
      log.warn(
        { sessionId: input.sessionId, minutes: input.minutes, path: input.path },
        'finalizeExternalDuration — duration already applied with different minutes (conflict → 409)'
      );
      throw error;
    }
    log.error(
      {
        sessionId: input.sessionId,
        minutes: input.minutes,
        path: input.path,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'finalizeExternalDuration — failed to apply duration / finalize'
    );
    throw error;
  }
}
