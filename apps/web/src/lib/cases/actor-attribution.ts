import { personWithOrgLabel } from '@balo/shared/parties';

/**
 * BAL-567 — THE RETROSPECTIVE ACTOR-ATTRIBUTION RULE FOR A CASE, IN ONE PURE FUNCTION.
 *
 * "Who actually did this?" for the two things either side of a case can do to a booking or to
 * the case itself: ask to move a consultation (`reschedule_proposals.proposed_by_user_id`) and
 * ask whether the case is sorted (`case_engagements.resolution_requested_by_user_id`).
 *
 * ⚠⚠ IT IS CONSUMED BY **BOTH** SURFACES — the `/cases` index card AND the case page's nudge —
 * AND THAT IS THE WHOLE REASON IT IS A MODULE. Before this ticket the case page said
 * "You've asked if this is sorted" to EVERY expert-side viewer, including an agency colleague
 * who did nothing (`resolveCaseAccess` admits any live agency member, ADR-1046 §7), and named
 * the counterparty PARTY where it meant a PERSON. Two surfaces re-deriving that from
 * `counterpartyLabel` is two places to get it wrong.
 *
 * ⚠ CLAUDE.md's ATTRIBUTION-BY-TENSE RULE. This is the RETROSPECTIVE register: it names the
 * PERSON, with "@ org" on first mention. The PROSPECTIVE register (who can act, whose review
 * window) names the PARTY and lives in `counterpartyPartyLabel` / `expertPartyDisplayName` —
 * the two are not interchangeable and must not be collapsed.
 *
 * ⚠⚠ THE "@ org" CLAUSE IS `personWithOrgLabel`'s, NEVER A SECOND TEMPLATE LITERAL. That
 * function's own docblock calls itself "the one place the '@ org' clause is decided", and it
 * already handles the three cases a hand-rolled `` `${name} @${org}` `` gets wrong: a blank org
 * (drop the clause rather than render a stand-in), an org label that IS the person's name (an
 * INDEPENDENT expert — "Dana Okoro @ Dana Okoro"), and a missing person name. CLAUDE.md spells
 * the rendered form with a space ("Accepted by Dana @ Northwind Industrial"), which is what that
 * function produces.
 *
 * ⚠ NAMES ONLY. Every input is an id or a name column; no email, no `workos_id`, no role. The
 * actor id is used for IDENTITY COMPARISON ONLY and is never an authorization input — the act
 * axis is `hasEngagementCapability` (ADR-1046), resolved from the engagement's delivery
 * identity, never from who happened to press the button.
 *
 * ⚠ UNDER IMPERSONATION `viewerUserId` is the TARGET's id (memory
 * `reference_impersonation_entry_point_exists_docblock_lies`), so "You" correctly names the
 * impersonated customer's own view. No special case.
 *
 * PURE, client-safe, no `server-only`: the index's card builder (server) and the case page's
 * loader (server) both call it, and its output — a plain string — is what crosses to the client.
 */

/** The viewer's own name, spelled exactly once on the platform. */
export const ATTRIBUTION_VIEWER_LABEL = 'You';

/** Which SIDE of the case is reading. Resolved server-side; never `activeMode`. */
export type AttributionSide = 'client' | 'expert';

export interface ActorAttributionInput {
  readonly side: AttributionSide;
  /** `null` when the column is null — nothing recorded who acted. */
  readonly actorUserId: string | null;
  /** `null` when the `users` row is gone, soft-deleted, or simply has no first name. */
  readonly actorFirstName: string | null;
  readonly viewerUserId: string;
  /** `expert_profiles.user_id` — the person actually delivering this case. */
  readonly deliveringExpertUserId: string;
  /** The delivering expert's agency, or `null` for an INDEPENDENT expert. */
  readonly agencyName: string | null;
  /** The PARTY to name when no person can be: the agency, else the expert's own name. */
  readonly partyFallbackLabel: string;
}

/** Trimmed, or `null` when the value is absent or blank. */
function presentName(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * THE RULE, exactly as the ticket's Attribution section states it:
 *
 * ```
 * no readable actor          → the PARTY label (agency, or an independent expert's own name)
 * client side, the expert    → their first name        ("Dana")        — already named on the card
 * client side, a colleague   → "{First name} @ {Agency}" ("Priya @ CloudPeak")
 * expert side, the viewer    → "You"
 * expert side, a colleague   → their first name        ("Priya")
 * ```
 *
 * ⚠ THE CLIENT ARM NEVER RETURNS "You". Every actor this rule attributes is EXPERT-SIDE (only
 * an expert proposes a reschedule, only an expert asks whether the case is sorted), so a client
 * viewer is never the actor. Returning "You" there would be a lie, and the expert arm's identity
 * comparison is what keeps the two apart.
 */
export function resolveActorLabel(input: ActorAttributionInput): string {
  const firstName = presentName(input.actorFirstName);
  if (input.actorUserId === null || firstName === null) {
    return input.partyFallbackLabel;
  }

  if (input.side === 'expert') {
    return input.actorUserId === input.viewerUserId ? ATTRIBUTION_VIEWER_LABEL : firstName;
  }

  // The client already sees the delivering expert's name on the card/party block, so repeating
  // the agency after it is noise — "Dana suggested new times", not "Dana @ CloudPeak suggested".
  if (input.actorUserId === input.deliveringExpertUserId) {
    return firstName;
  }
  return personWithOrgLabel(firstName, input.agencyName ?? input.partyFallbackLabel);
}

/** True when {@link resolveActorLabel} named the reader themselves. */
export function attributionNamesViewer(actorLabel: string): boolean {
  return actorLabel === ATTRIBUTION_VIEWER_LABEL;
}

/**
 * "You've asked if this is sorted" / "Priya asked if this is sorted".
 *
 * ⚠ SHARED BY THE CASE PAGE'S NUDGE AND THE INDEX CARD'S QUIET SLOT, so the two cannot drift
 * into telling one viewer two different stories about the same ask. The contraction is only
 * grammatical for the viewer arm, which is why this is a function and not a template at each
 * call site.
 */
export function resolutionAskPendingTitle(actorLabel: string): string {
  return attributionNamesViewer(actorLabel)
    ? "You've asked if this is sorted"
    : `${actorLabel} asked if this is sorted`;
}

/** "You suggested new times" / "Priya suggested new times". Same sharing rationale as above. */
export function proposalPendingTitle(actorLabel: string): string {
  return `${actorLabel} suggested new times`;
}
