/**
 * Availability gate for expert search (env var, not a PostHog flag — no
 * PostHog server-side flag infra exists in `apps/api`).
 *
 * `EXPERT_SEARCH_AVAILABILITY_GATE === 'on'` enables the gate; anything else
 * (unset / `'off'`) disables it. OFF in dev/test/staging (seeded experts show);
 * set ON in Railway prod before the BAL-80 DNS cutover.
 *
 * Read once per request in the route handler and passed into the (pure) repo as
 * `availabilityGateEnabled`, so the repository stays deterministic and testable.
 */
export function isAvailabilityGateEnabled(): boolean {
  return process.env.EXPERT_SEARCH_AVAILABILITY_GATE === 'on';
}
