import 'server-only';

import { errorMessage, log } from '@/lib/logging';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { checkSharedRateLimit } from '@/lib/rate-limit/shared-counter';
import type { SessionUser } from '@/lib/auth/session';
import { publishTypingSignal } from './ably-server';
import type { TypingSignal } from './channels';
import type { SendTypingSignalResult } from './typing-relay';

/**
 * ⚠ ONE LITERAL FOR EVERY REFUSAL — impersonated, throttled, gate denied, thread read-only, no
 * thread. Distinct answers would tell a caller which conversations exist and which are closed.
 * The rate check runs BEFORE the gate, so a throttled answer reveals nothing about the thread
 * either. The UI never shows it: a typing signal that does not go out is a non-event.
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
 * impersonated session, check the shared rate limit, run the surface's post gate, publish.
 *
 * ── ORDER: IMPERSONATION → RATE → GATE → PUBLISH ───────────────────────────────────────────
 *
 * The rate check (`checkSharedRateLimit`, bucket `typing-signal`) sits between the impersonation
 * refusal and the gate — never after it (see `send-meeting-reaction.ts`: a limiter placed after
 * the gate makes a refused request cost the reads it exists to protect). A throttled call
 * answers `{ success: false, error: TYPING_DENIED }` and calls neither the gate nor the publish.
 * The refusal is quiet: the relay already treats any refusal as "back off" (30 s), never as an
 * error, and there is no log on this path — attribution lives entirely in the api's gated
 * refusal log for the `typing-signal` bucket (see below).
 *
 * The bound on an HONEST client is structural: per tab and per surface, `typing-relay.ts` keeps
 * one call in flight with the latest signal winning, and backs off after a slow, refused or
 * failed call. A burst costs a `started` and a `stopped` (a burst ends on a 1.5 s pause, a blur,
 * a send or an emptied box) plus a heartbeat every 10 s — typically 10–15 calls per message sent.
 * One bucket covers all three surfaces: a person types in one composer at a time, and N tabs
 * cost about what one does.
 *
 * ⚠ NO SUCCESS LOG LINE. At 10–15 calls per message it would multiply log volume for no
 * operational question; abuse is attributed by the api's gated `Rate limit exceeded` refusal
 * log for the `typing-signal` bucket, keyed by user.
 *
 * ⚠ IMPERSONATION IS REFUSED, BEFORE THE RATE CHECK. An admin observing a user's thread must not
 * make that user appear to be typing to the other party; a keystroke that is never sent is too
 * low a bar for an attribution the real user never made. This also means typing never reaches
 * the shared-counter hop under impersonation, so the limiter is never called for that session.
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

  const verdict = await checkSharedRateLimit('typing-signal', user);
  if (!verdict.allowed) {
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
