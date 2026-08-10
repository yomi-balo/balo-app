import { z } from 'zod';

/**
 * BAL-408 — the Zod boundary for the guest routes.
 *
 * ⚠⚠ THERE IS DELIBERATELY NO `party` KEY AND NO `accessScope` KEY, and their absence is the
 * security property, not an omission:
 *   · `party` is derived from the ACTOR's resolved side by
 *     `authorizeMeetingParticipation`. A body field would let a client-side member mint an
 *     expert-side participant.
 *   · `accessScope` is computed server-side at invite time
 *     (`resolveGuestAccessScope`) and stored as the record of the grant. A body field would
 *     let a caller award themselves the whole retrospective engagement envelope.
 * Zod's default object behaviour STRIPS unknown keys, so a caller that sends either is
 * silently ignored rather than honoured — which is the correct outcome, but do not weaken
 * this to `.passthrough()`.
 */

/**
 * ⚠ 254 IS THE RFC 5321 MAXIMUM for a whole address path, not a round number. Bounding the
 * length also keeps the (linear, non-regex) canonicalisation downstream cheap on hostile
 * input.
 */
const guestEmail = z.string().trim().email().max(254);

const guestInvitee = z.object({
  email: guestEmail,
  /** Optional: a nameless guest is greeted generically, never by their email local part. */
  name: z.string().trim().min(1).max(160).optional(),
  /**
   * Defaults to `guest` (attends alongside). `delegate` (attends INSTEAD of the booker) is
   * accepted here and refused by the SERVICE for an expert-side actor with
   * `422 delegate_must_be_client_side` — an expert-side delegate is expert SUBSTITUTION,
   * which is out of scope and is additionally unrepresentable at the database
   * (`meeting_guest_delegate_is_client_side`). Refusing it in the service rather than only
   * at the CHECK is what makes the caller's error legible instead of a 500 from a `23514`.
   */
  participationRole: z.enum(['guest', 'delegate']).optional(),
});

export const inviteGuestsBodySchema = z.object({
  /**
   * ⚠ REQUIRED, AND IT IS THE CONTRACT FIELD. The only part of the invite API that differs
   * between the three consuming surfaces (BAL-400 booking confirm, BAL-421 case surface,
   * BAL-132 in-call), and the funnel dimension this whole event set exists to measure. A
   * default would silently mis-attribute every invite to one surface.
   */
  entryPoint: z.enum(['booking_confirm', 'case_surface', 'in_call']),
  /**
   * `.max(8)` = `MAX_MEETING_PARTICIPANTS - RESERVED_BASE_PARTICIPANTS`: the most guest seats
   * a meeting can ever have. This is a cheap PARSE-TIME bound on request size, NOT the cap —
   * the real cap counts the meeting's existing live guests and answers
   * `409 participant_cap_reached`. Duplicates within the batch are collapsed
   * case-insensitively by the service BEFORE that count, so a body naming one colleague three
   * times consumes one seat rather than three.
   */
  guests: z.array(guestInvitee).min(1).max(8),
});

export type InviteGuestsBody = z.infer<typeof inviteGuestsBodySchema>;

/** `:meetingId` alone — the list and invite routes. */
export const meetingIdParamsSchema = z.object({
  meetingId: z.string().uuid(),
});

/**
 * `:meetingId` + `:guestId` — remove, admit, deny.
 *
 * ⚠ BOTH are `.uuid()`-validated at the boundary so a malformed id becomes a `400
 * invalid_request` rather than reaching Postgres and raising `22P02` from inside a service
 * whose contract is that a caller never has to catch to stay safe.
 */
export const meetingGuestParamsSchema = z.object({
  meetingId: z.string().uuid(),
  guestId: z.string().uuid(),
});

export type MeetingGuestParams = z.infer<typeof meetingGuestParamsSchema>;
