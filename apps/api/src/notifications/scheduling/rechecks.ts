import type { ScheduledNotification, ScheduledNotificationPayload } from '@balo/db';
import { CONVERSATION_UNREAD_RECHECK, conversationUnreadRecheck } from './conversation-unread.js';

/**
 * What a fire-time guard decides.
 *
 * ⚠ IT RETURNS A PAYLOAD, NOT A BOOLEAN, AND THAT IS DELIBERATE (ADR-1047 Decision 6).
 * The guard exists precisely because the state it reads can move at any point — between
 * schedule and claim, and between claim and send — so it MUST read live state. Having read
 * it, the guard already holds the answer; returning `{ publish: true, payload }` lets it
 * hand back what it found instead of forcing a second, redundant read downstream in the
 * resolver or a template. A bare boolean would throw that read away.
 *
 * ⚠ A REBUILT PAYLOAD MUST STILL CARRY A NON-EMPTY `correlationId`. `Record<string, unknown>`
 * cannot express that, so the dispatch tick CHECKS IT AT RUNTIME immediately before the
 * publish and turns a payload without one into a terminal `failed` — never a best-effort
 * send. The reason is not cosmetic: `publisher.publish` derives the BullMQ `jobId` from it,
 * so a missing `correlationId` collapses every promise of that event into the single job
 * `event--undefined` and silently drops all but the first. Simplest safe practice for a
 * consumer: SPREAD the stored payload (`{ ...row.payload, ...whatChanged }`) rather than
 * building a fresh object from scratch.
 */
export type RecheckResult =
  | { publish: true; payload: ScheduledNotificationPayload }
  | { publish: false; reason: string };

/** A fire-time guard. Runs AFTER the claim and BEFORE the publish, on live state. */
export type ScheduledRecheck = (row: ScheduledNotification) => Promise<RecheckResult>;

/**
 * THE FIRE-TIME GUARD REGISTRY (ADR-1047 Decision 7).
 *
 * ⚠ STRING-KEYED, NEVER CLOSURES. `scheduled_notifications.recheck` stores the NAME of the
 * guard, because the row lives in Postgres for up to 30 days and must survive deploys — a
 * serialized function cannot. The name is the contract; the function is whatever the
 * currently-deployed build binds to it.
 *
 * ⚠ IT SHIPPED EMPTY, ON PURPOSE — BAL-420 landed the primitive INERT, naming BAL-424
 * (conversation unread) as a PROSPECTIVE consumer "if it takes the dependency at all".
 * **BAL-424 TOOK IT.** `conversation_unread` below is the registry's FIRST entry and the
 * primitive is no longer inert. Every later consumer registers its own guard here in its OWN
 * PR, alongside its event, rules and template — BAL-411 (reschedule-proposal unanswered) and
 * BAL-134 (client/expert absent) are still outstanding. Adding a key here without a consumer
 * would be dead code; adding a consumer's guard from another PR would be building that
 * consumer.
 *
 * Registering a guard is additive and needs nothing else: a row whose `recheck` names a key
 * in this record is guarded; a row whose `recheck` is NULL is not.
 */
export const SCHEDULED_RECHECKS: Record<string, ScheduledRecheck> = {
  // BAL-424 — "are these messages/files still unread?" See `conversation-unread.ts`.
  [CONVERSATION_UNREAD_RECHECK]: conversationUnreadRecheck,
};

/**
 * A row names a `recheck` that no longer exists in this build — the DEPLOY-SKEW case: a row
 * scheduled by an older build whose guard was since renamed or removed.
 *
 * FAILING CLOSED ON AN UNKNOWN GUARD IS THE ONLY SAFE READING (ADR Decision 7.6). Publishing
 * anyway would send a notification whose warrant nobody checked; skipping silently would
 * swallow one that may well still be owed. The dispatch tick turns this into a terminal
 * `failed` + `log.error`, so it is loud and visible rather than either kind of guess.
 */
export class UnknownRecheckError extends Error {
  readonly recheck: string;

  constructor(recheck: string) {
    super(`Unregistered scheduled-notification recheck: ${recheck}`);
    this.name = 'UnknownRecheckError';
    this.recheck = recheck;
  }
}

/**
 * Resolve and run the fire-time guard for one claimed row.
 *
 *  · `recheck` NULL/blank ⇒ `{ publish: true, payload: row.payload }` — correct for a
 *    genuinely unconditional reminder. The stored payload is the DEFAULT answer.
 *  · a REGISTERED name ⇒ whatever the guard decides, including a payload it may have
 *    rebuilt from the live state it just read.
 *  · an UNREGISTERED name ⇒ throws `UnknownRecheckError`. Never a silent publish, never a
 *    silent skip.
 *
 * A guard that THROWS anything else is deliberately not caught here: the dispatch tick
 * leaves such a row `claimed`, so it is retried after the claim TTL and only becomes
 * terminal once attempts are exhausted. A transient DB blip must not consume the
 * notification.
 */
export async function runRecheck(row: ScheduledNotification): Promise<RecheckResult> {
  const name = row.recheck;
  if (name === null || name.trim().length === 0) {
    return { publish: true, payload: row.payload };
  }

  const recheck = SCHEDULED_RECHECKS[name];
  if (recheck === undefined) {
    throw new UnknownRecheckError(name);
  }

  return recheck(row);
}
