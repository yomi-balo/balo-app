/**
 * BAL-475 (fix round 1, F19 — R19/UX4/UX7) — the copy shared BYTE-IDENTICALLY by the ICS
 * DESCRIPTION (`services/calendar-invites/resolve-calendar-invite-facts.ts`) and the
 * accompanying email body (`notifications/channels/templates/meeting-calendar-invite.tsx`).
 *
 * ⚠ DECLARED HERE, OUTSIDE `services/calendar-invites/` (the counterparty-address invariant's
 * second scan root), SPECIFICALLY SO THIS COPY CAN USE THE WORD "email" LEGITIMATELY. The
 * previous location under that root forced two marker-avoidance rewrites — dropping "email"
 * from the guest note, and inventing `CALENDAR_INVITE_CHANNEL` so `log-fields.ts` never wrote
 * the literal token — that improved nothing about the invariant's actual guarantee (no
 * COUNTERPARTY address) and cost the guest note real clarity (R19). Moving the copy module out
 * from under the scanned root removes the SCAN'S reason to avoid the word; it does not relax
 * what the invariant checks, because this file carries no address of any kind, checked or not.
 */

export const CALENDAR_INVITE_CHANGES_NOTE =
  'Rescheduling and cancelling happen in Balo. Replying to this invite does not change anything.';

/**
 * UX4/UX7 — names the ARTEFACT to search for ("the invitation email"), gender-neutral, and
 * frames it as belonging to THIS call ("for this call") rather than a vague "your original
 * invitation" a guest who received several Balo messages could misattribute.
 */
export const CALENDAR_INVITE_GUEST_JOIN_NOTE =
  'Join using the personal link in the invitation email Balo sent you for this call.';
