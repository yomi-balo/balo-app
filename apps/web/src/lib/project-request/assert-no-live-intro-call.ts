import 'server-only';

import { meetingsRepository } from '@balo/db';
import { pickUpcomingContextMeeting } from './conversation-view-types';

/**
 * BAL-283 (round-1 security MEDIUM) — THE SERVER-SIDE "one intro call per thread" GUARD.
 *
 * ⚠⚠ THE UI ALREADY CLAIMS THIS RULE; NOTHING USED TO ENFORCE IT. `deriveCallSlot` removes the
 * CTA from header and rail once `thread.bookedCall !== null`, and the nudge tells BOTH parties
 * there is nothing left to book — but the only thing standing between a caller and a second
 * booking was the browser. `bookingIdempotencyKey` is `sha256(userId:nonce)` with a
 * CLIENT-MINTED nonce, so a fresh nonce is a fresh booking BY CONSTRUCTION and the idempotency
 * layer can never collapse two of them. A client-company member could therefore fill the
 * delivering expert's published day one free call at a time while every surface told the expert
 * a single intro call was scheduled.
 *
 * The honest options were "enforce it" or "amend the docblock to admit `'booked'` is only a
 * DISPLAY state". Enforcing is the one that keeps the shipped copy true.
 *
 * ⚠ IT ASKS THE **SAME** QUESTION THE CTA DOES — `pickUpcomingContextMeeting`, the one shared
 * pick. That matters in both directions: an ENDED intro call must NOT block re-booking (the
 * whole point of round-1 C2), and a live upcoming one must block it. Two copies of that rule
 * would eventually let the server refuse a booking the UI was still offering.
 *
 * ⚠ IT IS NOT A UNIQUENESS CONSTRAINT AND DOES NOT PRETEND TO BE. This is a check-then-act, so
 * two requests racing inside the same instant can both pass. There is no partial unique index
 * to lean on (`meeting_contexts.context_id` is polymorphic and FK-less), and a lock here would
 * be the wrong shape for a rule that is about honest UI rather than about money or safety. It
 * closes the deliberate, repeatable abuse; it does not close a millisecond race.
 *
 * ⚠ READ-ONLY AND AUTHORIZATION-FREE. `listActiveMeetingsForContexts` resolves NO tenancy — the
 * caller must already have established the actor's right to this relationship
 * (`resolveConversationAccess`) before asking.
 */
export async function assertNoLiveIntroCall(relationshipId: string): Promise<boolean> {
  const byContext = await meetingsRepository.listActiveMeetingsForContexts({
    contextType: 'request_interaction',
    contextIds: [relationshipId],
  });
  const meetings = byContext.get(relationshipId) ?? [];
  return pickUpcomingContextMeeting(meetings, Date.now()) === undefined;
}
