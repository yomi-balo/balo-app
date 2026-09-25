'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { checkSharedRateLimit } from '@/lib/rate-limit/shared-counter';
import { authorizeMeetingFileAccess } from '@/lib/meetings/authorize-meeting-file-access';
import {
  CALL_ACTION_THROTTLED_ERROR,
  callActionErrorFields,
  enterCallAction,
} from '@/lib/meetings/call-action-entry';
import { MEETING_REACTIONS } from '@/lib/meetings/meeting-reactions';
import { publishMeetingEvent } from '@/lib/realtime/ably-server';
import { MEETING_EVENT_REACTION } from '@/lib/realtime/channels';
import type { SendMeetingReactionResult } from '@/lib/meetings/meeting-panels';

const inputSchema = z
  .object({
    meetingId: z.uuid(),
    /** ⚠ THE CLOSED SIX-MEMBER SET — see `meeting-reactions.ts`. Never a free string. */
    emoji: z.enum(MEETING_REACTIONS),
    /** Opaque; echoed so the sender can drop their own float. Never an identity. */
    nonce: z.uuid(),
  })
  .strict();

/**
 * BAL-437 — broadcast one ephemeral reaction to everybody in the call.
 *
 * ── ⚠⚠ IT PERSISTS **NOTHING**, AND THAT IS STRUCTURAL RATHER THAN INTENDED ─────────────
 *
 * There is no repository call of any kind on this path — the whole body is a gate and a
 * publish. That is what makes the acceptance criterion "reactions are never written to the
 * meeting record or the recap" true by construction: there is no table to write to, no enum
 * to widen and no column to forget about.
 *
 * ⚠⚠ **HOW THAT IS HELD: A SOURCE SCAN OF THIS FILE, NOT A `@balo/db` MOCK.** An earlier
 * version of this docblock claimed the test asserted it "by mock CALL COUNT". It does not, and
 * it could not: this module does not import `@balo/db` at all, so a `vi.mock('@balo/db')`
 * factory never runs and every assertion on it would pass over nothing.
 * `send-meeting-reaction.test.ts` instead READS THIS FILE and asserts it names no repository,
 * no `@balo/db` and no persistence verb.
 *
 * ⚠⚠ **IT SCANS THE CODE, WITH COMMENT LINES STRIPPED (`codeLinesOf`), AND THAT IS WHY THIS
 * DOCBLOCK MAY NAME THE THINGS IT DOES NOT DO.** Over the raw text, the sentence you are reading
 * would itself fail the invariant it describes — which would push the next author to document
 * less, exactly backwards. ⚠ A trailing `// …` after real code is deliberately KEPT by that
 * helper, so the residual failure mode of the choice is a false ALARM, never a false pass.
 *
 * ⚠ THE SCAN'S REAL LIMIT, STATED: it proves there is no DIRECT repository call **in this file**,
 * NOT that nothing on the path writes — the gate below reaches `@balo/db` transitively, as it
 * must. What makes the criterion hold end to end is that the gate is a pure read
 * (`authorizeMeetingFileAccess` mints no row), and that is the gate's own invariant.
 *
 * ── ⚠⚠ THE GATE IS `authorizeMeetingFileAccess` **DIRECTLY**, NOT `resolveMeetingChatAccess` ──
 *
 * A reaction is MEETING-grain: it needs participation and nothing else — no conversation anchor,
 * no thread lifecycle. `resolveMeetingChatAccess` composes the same gate and then does up to two
 * further reads (`conversationsRepository.findByContext`, plus the arm's lifecycle read) whose
 * results this action would discard. Calling it here would cost 6–10 reads where this gate
 * costs 4–8. Same decision, fewer reads.
 * ⚠ `authorizeMeetingFileAccess` IS THE MEETING-PARTICIPATION GATE ON THE WEB TIER — the "file"
 * in its name is historical, not a scope limit (see `meeting-chat-anchor.ts`'s docblock).
 *
 * ⚠⚠ AND IT IS NOT "chat access minus a bit": an `admin` or `ambiguous` meeting is DENIED by
 * this gate (`selectPrimaryMeetingContext` drops admin rows ⇒ primary context `none`), so such
 * a call has NO reactions, NO chat and NO realtime token. The one shape that really is
 * "reactions, no chat" is `project_discovery`: the gate grants, and the anchor is null.
 *
 * ── ⚠⚠ WHY THE CLIENT DOES NOT PUBLISH THIS ITSELF ──────────────────────────────────────
 *
 * A client publish would need the `publish` capability on the meeting channel, reversing
 * `ably-server.ts`'s shipped invariant that only the server publishes after validation. It
 * would also bypass the closed-emoji check entirely, turning the reaction overlay into a
 * "render arbitrary text over live video" surface. The Server Action hop costs one round trip
 * that the UI does not wait for: the float renders OPTIMISTICALLY the instant the emoji is
 * tapped, and the sender drops the server's echo by `nonce`.
 *
 * ── ⚠⚠ THE SERVER-SIDE THROTTLE (BAL-461) ───────────────────────────────────────────────
 *
 * Order is SESSION → RATE → GATE → ACT, the same order every one of the eight BAL-461 consumers
 * uses: `checkSharedRateLimit` runs immediately after `enterCallAction` resolves the actor, and
 * strictly BEFORE `authorizeMeetingFileAccess` below. Placed any later, a refused request would
 * still cost the platform the gate's own reads — the reaction gate alone is 4–8 indexed reads by
 * grain and actor, and the chat gate the other in-call actions call is 6–10, on top of the one
 * read every action already pays at the session step (`requireOnboardedUser` →
 * `assertAccountLive` → a `users` SELECT). The limiter would be spending exactly the resource it
 * exists to protect if it ran any later.
 *
 * The `meeting-reaction` bucket is 120 per 60s — above one tab's own cooldown ceiling
 * (60 000 / `REACTION_SEND_COOLDOWN_MS` 600 = 100, `use-meeting-realtime.ts`), so one tab tapping
 * flat out is not refused. The key is per user, so several tabs or devices tapping at the
 * ceiling, or queued arrivals, can still be refused. The refusal is QUIET: the float stays up,
 * exactly as it does for a tap the 600ms cooldown itself already coalesced (see
 * `use-meeting-realtime.ts`'s `sendReaction`).
 *
 * ⚠ FAIL OPEN. `checkSharedRateLimit` never throws and never blocks longer than 150ms — a Redis
 * outage or a secret mismatch means no limiting, never a broken call. See
 * `apps/web/src/lib/rate-limit/shared-counter.ts` for the full policy and its own gated log.
 *
 * ⚠⚠ THE SAME SHAPE COVERS THE OTHER SEVEN CONSUMERS. `postMeetingMessageAction` (the
 * `meeting-chat-post` bucket) and `fetchMeetingThreadAction` (`meeting-chat-read`) are the other
 * two unbounded write/read paths in this family; `createMeetingRealtimeTokenAction`
 * (`meeting-realtime-token`), the three typing relays — `sendMeetingTypingAction` here, plus
 * `sendCaseTypingAction` / `sendConversationTypingAction` on the dashboard, all through
 * `relayTypingSignal` (`typing-signal`) — and the proposal PDF route (`proposal-pdf`) round out
 * the eight. Bucket NAMES are the closed tuple in `@balo/shared/rate-limit`; bucket NUMBERS
 * (max/window) live only on `apps/api`, which is the one place they can change without a web
 * deploy.
 *
 * ⚠⚠ `{ success: true }` MEANS "ACCEPTED", NOT "DELIVERED". `publishMeetingEvent` never throws
 * and is deferred through `runAfterResponse`, so this returns before the publish is attempted
 * and a failure is a `log.error` nobody sees. That is the right trade — the sender's float
 * already rendered, so they are not misled — but it is written down so the next reader does
 * not mistake the return value for a delivery receipt.
 */
export async function sendMeetingReactionAction(
  input: z.infer<typeof inputSchema>
): Promise<SendMeetingReactionResult> {
  const entry = await enterCallAction(() => requireOnboardedUser(), inputSchema, input);
  if (!entry.ok) return { success: false, error: entry.error };
  const { user } = entry;
  const { meetingId, emoji, nonce } = entry.data;

  // ⚠⚠ SESSION → RATE → GATE. See the docblock. Fails open, and a refusal is quiet.
  const rateLimit = await checkSharedRateLimit('meeting-reaction', user);
  if (!rateLimit.allowed) {
    return { success: false, error: CALL_ACTION_THROTTLED_ERROR };
  }

  try {
    // ⚠ THE PARTICIPATION GATE, IN FULL — and nothing beyond it. See the docblock.
    const access = await authorizeMeetingFileAccess({
      meetingId,
      actor: { kind: 'member', userId: user.id },
    });
    if (!access.ok) {
      return { success: false, error: 'You are not in this call.' };
    }

    // ⚠ NO REPOSITORY CALL. NOT ONE. See the docblock.
    void publishMeetingEvent(meetingId, MEETING_EVENT_REACTION, { emoji, nonce });

    return { success: true };
  } catch (error) {
    // ⚠ NEVER LOG THE EMOJI (content) OR THE NONCE (correlates one person's taps across a
    // call) — the anonymity property this feature ships is about the WIRE PAYLOAD, not about
    // server-side observability of who called this action. Attribution for a flood now comes
    // from the api's gated `Rate limit exceeded` refusal log on the `meeting-reaction` bucket,
    // keyed by user (see `checkSharedRateLimit` above) — the success line this comment used to
    // sit under existed only "while BAL-461 is open", and is gone now that it is.
    log.error('Failed to send meeting reaction', {
      meetingId,
      userId: user.id,
      ...callActionErrorFields(error),
    });
    return { success: false, error: 'Could not send that reaction.' };
  }
}
