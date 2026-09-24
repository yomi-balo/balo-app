import 'server-only';

import { errorMessage, log } from '@/lib/logging';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import type { SessionUser } from '@/lib/auth/session';
import { publishTypingSignal } from './ably-server';
import type { TypingSignal } from './channels';
import type { SendTypingSignalResult } from './typing-relay';

/**
 * ⚠ ONE LITERAL FOR EVERY REFUSAL — impersonated, gate denied, thread read-only, no thread.
 * Distinct answers would tell a caller which conversations exist and which are closed. The UI
 * never shows it: a typing signal that does not go out is a non-event.
 */
export const TYPING_DENIED = 'Typing is not available here.';

/** The answer when the gate or the publish failed, after authorization could be attempted. */
const TYPING_FAILED = 'Could not send typing status.';

export interface RelayTypingSignalInput {
  /** The SESSION user — `requireOnboardedUser()`. Their id becomes the published `clientId`. */
  readonly user: SessionUser;
  readonly signal: TypingSignal;
  /**
   * ⚠⚠ THE SURFACE'S **POST** GATE, returning the conversation this user may POST to, or `null`.
   * "You may signal typing exactly when you may post" — so each action passes the same
   * resolution its post action runs, writability included, and never a looser read gate.
   */
  readonly resolvePostableConversationId: () => Promise<string | null>;
  /** The action's correlation ids, for the failure log line only. */
  readonly logContext: Readonly<Record<string, string>>;
}

/**
 * The shared tail of the three typing Server Actions (case, project request, in-call): refuse an
 * impersonated session, run the surface's post gate, publish.
 *
 * ── ⚠⚠ NO SERVER-SIDE RATE LIMIT YET ───────────────────────────────────────────────────────
 *
 * Order is SESSION → GATE → PUBLISH, and a rate check belongs between the first two (see
 * `send-meeting-reaction.ts`: a limiter placed after the gate makes a refused request cost the
 * reads it exists to protect). The web tier has no shared counter; **BAL-461** is the ticket for
 * one, and it currently names the in-call actions only — these three typing actions must be ADDED
 * to it (they are listed with the others in `send-meeting-reaction.ts`). A throttled typing call
 * must answer quietly: the relay already treats any refusal as "back off", never as an error.
 *
 * The bound on an HONEST client is structural: per tab and per surface, `typing-relay.ts` keeps
 * one call in flight with the latest signal winning, and backs off after a slow or refused call.
 * A burst costs a `started` and a `stopped` (a burst ends on a 1.5 s pause, a blur, a send or an
 * emptied box) plus a heartbeat every 10 s — typically 10–15 calls per message sent.
 *
 * ⚠ NO SUCCESS LOG LINE, unlike `sendMeetingReactionAction`. At 10–15 calls per message it would
 * multiply log volume for no operational question; attribution of abuse belongs to the BAL-461
 * limiter's refusal log, keyed by user.
 *
 * ⚠ IMPERSONATION IS REFUSED. An admin observing a user's thread must not make that user appear
 * to be typing to the other party; a keystroke that is never sent is too low a bar for an
 * attribution the real user never made.
 *
 * ⚠ `{ success: true }` MEANS PUBLISHED: `publishTypingSignal` is awaited, which is what keeps a
 * sender's `started` / `stopped` in order on the channel. A failed PUBLISH is a transport event
 * (an Ably timeout, rate limit or outage) and is logged as a warning without a stack; a failed
 * GATE is a real fault and is logged as an error.
 */
export async function relayTypingSignal(
  input: RelayTypingSignalInput
): Promise<SendTypingSignalResult> {
  const { user, signal, resolvePostableConversationId, logContext } = input;
  if (isImpersonatedSession(user)) {
    return { success: false, error: TYPING_DENIED };
  }

  let conversationId: string | null;
  try {
    conversationId = await resolvePostableConversationId();
  } catch (error) {
    log.error('Failed to authorize typing signal', {
      ...logContext,
      userId: user.id,
      signal,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: TYPING_FAILED };
  }
  if (conversationId === null) {
    return { success: false, error: TYPING_DENIED };
  }

  try {
    await publishTypingSignal(conversationId, user.id, signal);
    return { success: true };
  } catch (error) {
    log.warn('Typing signal not published', {
      ...logContext,
      userId: user.id,
      signal,
      error: errorMessage(error),
    });
    return { success: false, error: TYPING_FAILED };
  }
}
