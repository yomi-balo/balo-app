/**
 * The client-safe shapes of an AI-drafted proposal (BAL-611): what the start and poll actions
 * return and what the composer applies. Type-only, so a client component may import it.
 *
 * Everything here is already sanitised: `ProposalDraftPatch` is built by
 * `toProposalDraftPatch` in `proposal-draft-view.ts`, and raw model output never crosses
 * this boundary.
 */

/** One drafted milestone, ready to drop into a composer milestone row. */
export interface ProposalDraftMilestonePatch {
  /** Trimmed plain text, rendered as an input value. */
  title: string;
  /** Sanitised with `sanitizeProjectHtml`. */
  descriptionHtml: string;
  /** Trimmed plain text, rendered as an input value. */
  acceptanceCriteria: string;
}

/** The sanitised draft the composer applies to its Overview and Milestones sections. */
export interface ProposalDraftPatch {
  /** Sanitised with `sanitizeProposalOverviewHtml`. */
  overviewHtml: string;
  milestones: ProposalDraftMilestonePatch[];
}

/**
 * Where a relationship's one automatic generation stands.
 *
 *   none       no generation exists yet; the composer starts one
 *   pending    a generation is running; the composer polls it
 *   succeeded  the draft is ready to apply
 *   failed     it failed, could not be enqueued, or has been pending past the deadline
 *   skipped    nothing was or will be generated (at the hourly cap, the gate refused, or a
 *              proposal already exists); the composer shows a blank state with no note
 */
export type ProposalDraftGenerationView =
  | { status: 'none' }
  | { status: 'pending'; generationId: string }
  | { status: 'succeeded'; generationId: string; patch: ProposalDraftPatch }
  | { status: 'failed' }
  | { status: 'skipped' };
