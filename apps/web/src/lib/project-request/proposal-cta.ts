/**
 * The shared blue→violet gradient FILL for primary commit CTAs across the
 * project-request / proposal feature (header "Build proposal", the rail, the
 * thread/page nudges, the proposal slot, and the composer summary-card "Submit").
 *
 * This is the gradient + text colour ONLY — callers compose it with their own
 * layout/size/radius classes so a small header pill and a full-width summary
 * button can share the exact same gradient without duplicating the literal.
 */
export const PROPOSAL_CTA_GRADIENT_CLASS =
  'from-primary bg-gradient-to-r to-violet-600 text-white dark:to-violet-500';
