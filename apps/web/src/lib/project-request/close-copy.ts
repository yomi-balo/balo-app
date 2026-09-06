import {
  narrowToDeclinableRelationshipStatus,
  type DeclinableRelationshipStatus,
  type ProjectRequestCloseReason,
} from '@balo/shared/project-requests';

/**
 * close-copy — BAL-540's pure, client-safe copy module for the close-request /
 * decline-track surfaces (Phase 6.1). Hoists the design reference's data
 * structures (`.claude/design-references/request-close.jsx`) so every string is
 * stated ONCE and iterated, never copy-pasted across the sheet, the dialog and
 * the banner. `pending-MJ` on every user-facing string (CLAUDE.md).
 *
 * NO `@balo/db` IMPORT AT ALL (not even type-only) and NO `server-only` — both
 * the close sheet and the decline dialog are client components that need this
 * copy in the browser bundle, and a client component that value-imports
 * `@balo/db` fails `next build`. The two unions come from
 * `@balo/shared/project-requests`, which exists for exactly that reason.
 *
 * ⚠ "Party" collapses to the expert's own display name here. The design
 * reference shows a separate agency/company "party" ("Priya Nair @ CloudPeak"),
 * but that agency label is not yet hydrated onto `RequestDetailView`'s
 * relationships (a `packages/db` widening out of this ticket's minimal-footprint
 * scope). Documented deviation — a future pass can thread a genuine
 * `expertPartyDisplayName` through once the relationship query carries agency
 * data; until then `partyLabel === expertName`, which is also literally correct
 * for the common case of an independent expert (CLAUDE.md: "independent experts
 * keep their own name").
 */

/**
 * The four relationship stages a track can be declined FROM. A LOCAL NAME for
 * `@balo/shared/project-requests`' `DeclinableRelationshipStatus` — the ONE definition, shared
 * with both Server Actions, both notification payloads and the analytics event map. `TrackStage`
 * survives as the name every close/decline COMPONENT already reads.
 */
export type TrackStage = DeclinableRelationshipStatus;

/**
 * Client-safe narrowing of a raw relationship status to a {@link TrackStage}, or `null` for
 * `accepted`/`declined`/anything else. A re-export of the shared narrowing under this module's
 * local vocabulary — there is exactly one implementation
 * (`narrowToDeclinableRelationshipStatus`), consulted by every surface that has to decide
 * whether a row is declinable.
 */
export const narrowToTrackStage: (status: string) => TrackStage | null =
  narrowToDeclinableRelationshipStatus;

/** The admin-only close reasons (design ref `CLOSE_REASONS`, `:459-470`). Never `'withdrawn'` — that is the client's own, stated reason. */
export interface CloseReasonOption {
  key: Exclude<ProjectRequestCloseReason, 'withdrawn'>;
  label: string;
  hint: string;
}

export const CLOSE_REASONS: readonly CloseReasonOption[] = [
  {
    key: 'declined',
    label: 'Balo declined', // pending-MJ
    hint: 'Not a fit for the marketplace, or outside what we can staff.', // pending-MJ
  },
  {
    key: 'unfilled',
    label: 'Unfilled', // pending-MJ
    hint: 'We could not find an expert in time.', // pending-MJ
  },
  {
    key: 'superseded',
    label: 'Superseded', // pending-MJ
    hint: 'Replaced by another request from the same company.', // pending-MJ
  },
];

/** Every close-reason label, including the client's own `'withdrawn'` (design ref `:883-888`). */
export const REASON_LABEL: Record<ProjectRequestCloseReason, string> = {
  withdrawn: 'Withdrawn', // pending-MJ
  declined: 'Balo declined', // pending-MJ
  unfilled: 'Unfilled', // pending-MJ
  superseded: 'Superseded', // pending-MJ
};

/** The verb on the decline control at each stage (design ref `STAGES`, `:388-397`). */
export function declineVerbFor(stage: TrackStage): string {
  // pending-MJ (both verbs)
  return stage === 'invited' ? 'Withdraw invite' : 'Decline';
}

/** What is being declined, in words — feeds the confirm title. */
function nounFor(stage: TrackStage): string {
  switch (stage) {
    case 'invited':
      return 'invitation'; // pending-MJ
    case 'eoi_submitted':
    case 'proposal_requested':
      return 'expression of interest'; // pending-MJ
    case 'proposal_submitted':
      return 'proposal'; // pending-MJ
  }
}

/** The decline confirm's title (design ref `DeclineConfirm`, `:594-597`). */
export function declineTitleFor(stage: TrackStage, expertName: string): string {
  if (stage === 'invited') return `Withdraw ${expertName}’s invitation?`; // pending-MJ
  return `Decline ${expertName}’s ${nounFor(stage)}?`; // pending-MJ
}

/** The decline confirm's body — names the party told + the files rule (design ref `:598-603`). */
export function declineBodyFor(stage: TrackStage, partyLabel: string): string {
  if (stage === 'invited') {
    // pending-MJ
    return `${partyLabel} is told the invitation was withdrawn. Nothing was shared with them beyond the brief.`;
  }
  if (stage === 'proposal_submitted') {
    // pending-MJ
    return `${partyLabel} is told you’re not proceeding. Their proposal is declined, and the files they had access to stay exactly as they were — nothing new is shared.`;
  }
  // pending-MJ
  return `${partyLabel} is told you’re not proceeding. The files they had access to stay exactly as they were.`;
}

/** One live track the close sheet's consequence list names (design ref `consequenceFor`, `:452-458`). */
export interface CloseConsequenceTrack {
  expertName: string;
  partyLabel: string;
  stage: TrackStage;
}

/**
 * The per-track consequence sentence — the close sheet's load-bearing copy: prospective,
 * names the party that will be told, states what happens to the work (design ref
 * `consequenceFor`, `:452-458`).
 */
export function consequenceFor(track: CloseConsequenceTrack): string {
  switch (track.stage) {
    case 'proposal_submitted':
      // pending-MJ
      return `${track.expertName}’s proposal is withdrawn, and ${track.partyLabel} is told you’re not proceeding.`;
    case 'eoi_submitted':
    case 'proposal_requested':
      // pending-MJ
      return `${track.expertName}’s expression of interest ends, and ${track.partyLabel} is told.`;
    case 'invited':
      // pending-MJ
      return `${track.expertName}’s invitation is withdrawn. ${track.partyLabel} is told.`;
  }
}

/** Minimum Balo-only note length the admin close sheet requires (D-required, design ref `:690`). */
export const CLOSE_NOTE_MIN_LENGTH = 8;

/** The Balo-only note textarea's placeholder (design ref `:829`). */
export function closeNotePlaceholderFor(companyName: string): string {
  // pending-MJ
  return `What the next person at Balo should know — never shown to ${companyName} or the experts`;
}
