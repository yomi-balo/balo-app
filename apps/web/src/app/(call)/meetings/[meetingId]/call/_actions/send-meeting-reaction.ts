'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { authorizeMeetingFileAccess } from '@/lib/meetings/authorize-meeting-file-access';
import { callActionErrorFields, enterCallAction } from '@/lib/meetings/call-action-entry';
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
 * results this action would discard. Calling it here cost ~6 database round trips where ~4 do,
 * on the one endpoint in this family with **no throttle at all**. Same decision, fewer reads.
 * ⚠ `authorizeMeetingFileAccess` IS THE MEETING-PARTICIPATION GATE ON THE WEB TIER — the "file"
 * in its name is historical, not a scope limit (see `meeting-chat-anchor.ts`'s docblock).
 *
 * ⚠⚠ AND IT IS NOT "chat access minus a bit": an `admin` or `ambiguous` meeting is DENIED by
 * this gate (`selectPrimaryMeetingContext` drops admin rows ⇒ primary context `none`), so such
 * a call has NO reactions, NO chat and NO realtime token. The one shape that really is
 * "reactions, no chat" is `project_discovery`: the gate grants, and the anchor is null.
 *
 * ── ⚠⚠ WHY THE CLIENT DOES NOT PUBLISH THIS ITSELF (ruling R2) ──────────────────────────
 *
 * A client publish would need the `publish` capability on the meeting channel, reversing
 * `ably-server.ts`'s shipped invariant that only the server publishes after validation. It
 * would also bypass the closed-emoji check entirely, turning the reaction overlay into a
 * "render arbitrary text over live video" surface. The Server Action hop costs one round trip
 * that the UI does not wait for: the float renders OPTIMISTICALLY the instant the emoji is
 * tapped, and the sender drops the server's echo by `nonce`.
 *
 * ── ⚠⚠ STATED LIMITATION: **THERE IS NO SERVER-SIDE THROTTLE. BAL-461 OWNS IT.** ────────
 *
 * Mitigation today is CLIENT-SIDE ONLY — a 600ms per-sender cooldown on the NETWORK call plus
 * the picker closing on selection. Neither binds a scripted client, which can drive **one
 * serverless invocation per request** against this endpoint. `apps/web` has no shared counter
 * (no Redis in the web tier) and an in-memory bucket is meaningless on serverless, so a real
 * throttle needs a shared store — that is **BAL-461**. Do not read the cooldown in
 * `use-meeting-realtime.ts` as coverage; it is a UX affordance that happens to reduce volume.
 *
 * ⚠⚠ **THE SAME GAP BINDS THE OTHER IN-CALL ACTIONS, AND BAL-461 MUST COVER THEM TOO.**
 * `postMeetingMessageAction` is an UNBOUNDED WRITE path — every accepted call INSERTs a
 * `conversation_messages` row and publishes — and `fetchMeetingThreadAction` is an unbounded
 * READ that pages 30 rows per call behind a bare `requireUser()`. Neither has any rate limit
 * either. Reactions are merely the cheapest to abuse, not the only one exposed.
 *
 * ⚠⚠ **BAL-461 MUST CHECK THE RATE *BEFORE* THE TENANCY GATE.** Every action in this family
 * authenticates, then authorizes, then acts — and the authorization is ~4–6 indexed reads. A
 * limiter placed after it makes an attacker's refused request cost the platform those reads;
 * the limiter would be spending exactly the resource it exists to protect. Order must be:
 * session → rate → gate.
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

  try {
    // ⚠ THE PARTICIPATION GATE, IN FULL — and nothing beyond it. See the docblock.
    const access = await authorizeMeetingFileAccess({ meetingId, userId: user.id });
    if (!access.ok) {
      return { success: false, error: 'You are not in this call.' };
    }

    // ⚠ NO REPOSITORY CALL. NOT ONE. See the docblock.
    void publishMeetingEvent(meetingId, MEETING_EVENT_REACTION, { emoji, nonce });

    // ⚠⚠ THE SUCCESS LINE EXISTS SO SPAM IS **ATTRIBUTABLE** WHILE BAL-461 IS OPEN. Without it
    // the only trace of a flood is Ably's own dashboard, which names no Balo user. ⚠ NEVER THE
    // EMOJI AND NEVER THE NONCE: the first is content, the second correlates one person's taps
    // across a call. The anonymity property this feature ships is about the WIRE PAYLOAD — what
    // other participants receive — not about server-side observability of who called an endpoint.
    log.info('Meeting reaction sent', { meetingId, userId: user.id });

    return { success: true };
  } catch (error) {
    // ⚠ NEVER LOG THE EMOJI OR THE NONCE — see the success line above.
    log.error('Failed to send meeting reaction', {
      meetingId,
      userId: user.id,
      ...callActionErrorFields(error),
    });
    return { success: false, error: 'Could not send that reaction.' };
  }
}
