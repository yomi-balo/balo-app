/**
 * BAL-593 — the locked-certifications refusal copy, pulled out of `save-certifications.ts`
 * (a `'use server'` module, which may export only async functions) so the constant doesn't trip
 * `apps/web/src/invariants/use-server-exports-only-async.test.ts`. Mirrors
 * `(apply)/expert/apply/_actions/declined-application-copy.ts`.
 *
 * A locked profile refuses ANY cert-set change (either direction), checked IN the write's own
 * transaction (`saveSettingsCertifications`'s `FOR UPDATE` on `expert_profiles`), never as a
 * read-before-write: an approval landing between a read and an unconditional write could
 * otherwise slip a change past the lock. `trailheadUrl` is not part of the lock — it keeps saving
 * even when the cert set is unchanged.
 */
export const CERTIFICATIONS_LOCKED_ERROR =
  'Your certifications were verified by Balo when you were approved, so only Balo can change them. Email support@getbalo.com to ask for a change.';
