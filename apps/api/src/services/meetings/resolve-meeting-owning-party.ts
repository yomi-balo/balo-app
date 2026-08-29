/**
 * BAL-410 — THE ONE `apps/api`-side BINDING of the shared owning-party rule, extracted so the
 * meeting authorization gates share it rather than each carrying a verbatim copy.
 *
 * ⚠ EXTRACTED, NOT INVENTED. This block was byte-identical in
 * `authorize-meeting-reschedule.ts` (whose copy BAL-410's cancel gate was modelled on), and a
 * third copy would have been a guaranteed jscpd hit against SonarCloud's >3% new-code
 * duplication gate — and, more importantly, a third place for the READ BINDING to drift.
 * ⚠ `authorize-meeting-participation.ts` STILL CARRIES ITS OWN COPY, AND THAT IS LEFT ALONE ON
 * PURPOSE RATHER THAN OVERLOOKED. Its copy exists behind a long, explicit argument — LOGGING
 * LOCALITY: it keeps the exhaustiveness witness at that gate so a seventh context label stops
 * `tsc` in the file whose log voice (`meeting-participation-authz`) would report it. Migrating
 * it would move that warn's scope name and overrule a settled decision in a gate BAL-410 is not
 * otherwise touching. If a future ticket does migrate it, move that reasoning here rather than
 * deleting it. `authorize-meeting-reschedule-proposal.ts` re-reads the owner by a different
 * shape entirely and never had this block.
 *
 * ⚠ THE RULE ITSELF IS NOT HERE. `resolveContextOwner` lives in `@balo/shared/meetings` and is
 * the single definition of "who owns this meeting context"; this module is only the `@balo/db`
 * BINDING plus the fail-closed reduction of its outcome union. Do not reimplement the rule.
 *
 * ⚠ IT RESOLVES OWNERSHIP; IT AUTHORIZES NOTHING. It reports which company owns a context row
 * and says nothing about whether the caller may see it. Every caller must still run its own
 * capability check — see each gate's docblock.
 */
import {
  engagementsRepository,
  projectRequestsRepository,
  requestExpertRelationshipsRepository,
} from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  resolveContextOwner,
  type MeetingContextOwner,
  type MeetingContextOwnerReads,
  type PrimaryMeetingContext,
} from '@balo/shared/meetings';

const log = createLogger('meeting-owning-party');

/**
 * THE REPOSITORY BINDING for the shared owning-party rule — the three `@balo/db` finders passed
 * in rather than reached for inside the pure core, so a factory-literal `vi.mock('@balo/db')` in
 * a caller's test does not have to grow to cover a ready-bound resolver. Each finder already
 * filters `deleted_at IS NULL`.
 */
export const OWNING_PARTY_READS = {
  findEngagement: (engagementId: string) => engagementsRepository.findById(engagementId),
  findProjectRequest: (projectRequestId: string) =>
    projectRequestsRepository.findById(projectRequestId),
  findRelationship: (relationshipId: string) =>
    requestExpertRelationshipsRepository.findById(relationshipId),
} satisfies MeetingContextOwnerReads;

/**
 * Per-context-type LOAD of the owning party, delegating to the ONE shared core in
 * `@balo/shared/meetings`. Deliberately judgement-free.
 *
 * `undefined` means "no owning party could be resolved", and it deliberately COLLAPSES two
 * cases the caller must not distinguish: the row is missing, or it is soft-deleted.
 */
export async function loadOwningParty(
  subject: PrimaryMeetingContext
): Promise<MeetingContextOwner | undefined> {
  const result = await resolveContextOwner(subject, OWNING_PARTY_READS);

  switch (result.outcome) {
    case 'resolved':
      return result.owner;
    // Missing OR soft-deleted, indistinguishable by construction.
    case 'not_found':
      return undefined;
    default: {
      // Compile-time exhaustiveness over the SIX holder-bearing labels — a SEVENTH non-admin
      // label widens `UnhandledMeetingContextType` away from `never` and stops
      // `pnpm --filter api typecheck` right here until an arm is consciously written. Fails
      // CLOSED rather than throwing: every caller of this is an authorization gate.
      const exhaustive: never = result.contextType;
      log.warn({ contextType: exhaustive }, 'Unhandled meeting context type — failing closed');
      return undefined;
    }
  }
}
