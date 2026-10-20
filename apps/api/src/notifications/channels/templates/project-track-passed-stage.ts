/**
 * BAL-604 — the stage phrase the staff-facing `project.track_passed` copy appends, one per
 * passable stage. Empty for an unrecognised value so a sparse payload never renders "undefined".
 * REGISTER (pending-MJ): factual, gender-neutral.
 */
const PASSED_STAGE_PHRASES: Readonly<Record<string, string>> = {
  invited: 'before responding to the invitation', // pending-MJ
  eoi_submitted: 'after expressing interest', // pending-MJ
  proposal_requested: 'after a proposal was requested', // pending-MJ
};

/**
 * Replaces the stage phrase for the direct request's chosen expert: their `eoi_submitted` was
 * written when the client sent the request, so "after expressing interest" would be untrue.
 */
const DIRECT_REQUEST_PHRASE = 'on a direct request'; // pending-MJ

/**
 * The phrase with a leading space, ready to append to a sentence; `''` when there is none. Only a
 * literal `onDirectLeg: true` selects the direct-request phrase.
 */
export function passedStageClause(fromStatus: unknown, onDirectLeg: unknown): string {
  if (onDirectLeg === true) return ` ${DIRECT_REQUEST_PHRASE}`;
  const phrase = typeof fromStatus === 'string' ? PASSED_STAGE_PHRASES[fromStatus] : undefined;
  return phrase ? ` ${phrase}` : '';
}
