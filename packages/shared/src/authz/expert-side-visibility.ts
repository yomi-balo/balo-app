/**
 * ⚠ THE SINGLE DEFINITION OF "this actor stands on the EXPERT SIDE" (BAL-419 / ADR-1046 §7,
 * resolved 2026-08-03). There must never be a second definition of expert-side VISIBILITY —
 * exactly as `relationshipDeniesHosting` (`./engagement`) is the single definition of
 * "declined" on the ACT axis.
 *
 * ⚠⚠ THIS IS **NOT** A FOURTH CAPABILITY AXIS. It adds no token to `CAPABILITIES`, no
 * role→capability map, no `*_CAPABILITIES` constant. Rights here sit on party membership
 * (ADR-1029): the question is "is this person inside the agency", not "does their role carry
 * a token". Adding a token would also trip the disjointness pins in
 * `apps/api/src/authz/engagement-capability-disjoint.ts` and
 * `apps/web/src/invariants/engagement-capability-not-membership.test.ts`.
 *
 * ⚠ IT IS DELIBERATELY WIDER THAN THE ACT AXIS, AND THE WIDTH IS THE POINT.
 *   · VISIBILITY (here)                     — delivering expert ∪ ANY live agency member,
 *                                             INCLUDING agency role `expert`.
 *   · ACT (`resolveHostRole`, ./engagement) — delivering expert ∪ agency `owner`/`admin`.
 * An agency colleague pulled into a case reads the case, its notes and its recaps; they do
 * not host, admit, reschedule, cancel or resolve. ADR-1046 §7: "Do not narrow it." The
 * failure mode this predicate exists to prevent is a future refactor "fixing" the
 * inconsistency by narrowing visibility to match the host holder set.
 * `expert-side-visibility.test.ts` runs BOTH predicates over ONE agency-role table, so an
 * "alignment" fails there, beside the sentence saying not to.
 *
 * ⚠ MEMBERSHIP EXISTING GRANTS. Never a role comparison, never `roleHasCapability`. The
 * `agencyRole !== undefined` on the last line IS the rule, and it is now the ONLY place on
 * the platform it is written. Its three consumers are
 * `authorizeSessionExpertVisibility` (`apps/api` credit-session money block),
 * `authorizeEngagementConversation` and `authorizeMeetingFileAccess` (`apps/web`).
 *
 * ⚠ WHY IT TAKES A LOOKUP CALLBACK RATHER THAN AN ALREADY-RESOLVED ROLE. The short-circuit
 * is part of the shipped contract: the delivering expert and an INDEPENDENT expert resolve
 * with NO agency lookup at all, asserted by call-count at all three call sites. A predicate
 * over an eagerly-resolved role would force a DB round-trip that today never happens. The
 * callback keeps the whole rule — including the ARM ORDER — in one place while this module
 * stays import-free: NO `@balo/db`, NO I/O, bundle-safe in a client graph.
 *
 * ⚠ WHY THE CALLBACK IS HANDED `actorUserId` INSTEAD OF CAPTURING IT — DO NOT "SIMPLIFY" IT
 * AWAY. A one-argument `(agencyId) => …` would thread actor identity through TWO independent
 * channels: the `actorUserId` parameter, and whatever `userId` the closure happened to
 * capture. Nothing would structurally bind them, so building ONE lookup and reusing it across
 * actors — the natural resolve-once / check-many shape — would silently grant:
 *
 *   const lookup = (agencyId) => getMemberRole('agency', agencyId, ownerId);
 *   await actorHasExpertSideVisibility(profile, attackerId, lookup);   // → true
 *
 * That is EXACTLY the confused deputy `HostContext.resolvedForActorId` (`./engagement`) was
 * added to defeat on the sibling ACT axis (BAL-413), and this predicate is exported from the
 * SAME barrel. Passing the actor as the callback's SECOND ARGUMENT makes the misuse
 * unwritable rather than merely discouraged: the lookup cannot know which actor to ask about
 * except by being told, per call. Every call site is therefore
 * `(agencyId, actorId) => …getMemberRole('agency', agencyId, actorId)` — never a captured id.
 *
 * ⚠ `profile === undefined` IS NOT THIS FUNCTION'S BUSINESS. Each gate answers a missing
 * profile with its own denial shape and log reason; routing that through here would flatten
 * three distinct operational signals into one boolean.
 */

/**
 * The already-fetched `expert_profiles` projection this rule reads. STRUCTURAL — `@balo/db`'s
 * row satisfies it and nothing here imports `@balo/db`.
 */
export interface ExpertSideVisibilityProfile {
  /** `expert_profiles.userId` — the DELIVERING expert. */
  readonly userId: string;
  /** `expert_profiles.agencyId`. `null` ⇒ INDEPENDENT expert: nobody to be a colleague of. */
  readonly agencyId: string | null;
}

/**
 * Resolve `actorUserId`'s LIVE membership role in `agencyId`, or `undefined` when they hold
 * none.
 *
 * ⚠ BOTH ARGUMENTS ARE SUPPLIED PER CALL, ON PURPOSE. `actorUserId` is NOT redundant with the
 * one the caller already passed to `actorHasExpertSideVisibility` — it is what stops a lookup
 * built for one actor from answering for another. See the module docblock's confused-deputy
 * note; do not collapse this back to `(agencyId) => …`.
 */
export type AgencyRoleLookup = (
  agencyId: string,
  actorUserId: string
) => Promise<string | undefined>;

/**
 * True when `actorUserId` stands on the expert side of `profile`. See the module docblock:
 * this is the VISIBILITY rule, deliberately wider than the act-axis holder set.
 */
export async function actorHasExpertSideVisibility(
  profile: ExpertSideVisibilityProfile,
  actorUserId: string,
  lookupAgencyRole: AgencyRoleLookup
): Promise<boolean> {
  // ARM 1 — the delivering expert themselves. No agency lookup on either profile shape.
  if (profile.userId === actorUserId) return true;

  // An INDEPENDENT expert has no agency for anyone to be a colleague of. No lookup.
  if (profile.agencyId === null) return false;

  // ARM 2 — an agency colleague. MEMBERSHIP EXISTING GRANTS. See the docblock: this single
  // comparison is the line ADR-1046 §7 forbids narrowing. The actor is passed EXPLICITLY to
  // the lookup, never captured by it — see the module docblock's confused-deputy note.
  const agencyRole = await lookupAgencyRole(profile.agencyId, actorUserId);
  return agencyRole !== undefined;
}
