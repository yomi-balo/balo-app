/**
 * Shared portfolio-inbox front-door constant (BAL-274 / D3). There is no `/projects/new`
 * route. The per-expert `ProjectRequestPanel` on marketing expert-profile pages is not the
 * only creation surface — `/` also opens a context-free one (BAL-582) — but the "New request"
 * button and the client empty-state CTA here point at expert discovery. Repointing this
 * constant to the generic front door is out of scope (R6); when it happens it stays a
 * one-line rewire, no component changes.
 */
export const NEW_REQUEST_HREF = '/experts';

/** Where the expert empty-state CTA sends an expert to complete their profile. */
export const EXPERT_PROFILE_HREF = '/expert/settings';
