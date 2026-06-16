/**
 * Shared portfolio-inbox front-door constant (BAL-274 / D3). There is no
 * `/projects/new` route yet — the only creation surface is the per-expert
 * `ProjectDrawer` on marketing expert-profile pages, so the "New request" button
 * and the client empty-state CTA both point at expert discovery. When BAL-253's
 * generic "match" front door lands, repoint this single constant — a one-line
 * rewire, no component changes.
 */
export const NEW_REQUEST_HREF = '/experts';

/** Where the expert empty-state CTA sends an expert to complete their profile. */
export const EXPERT_PROFILE_HREF = '/expert/settings';
