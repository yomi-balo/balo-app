import {
  resolveContextOwner,
  type MeetingContextOwner,
  type MeetingContextOwnerReads,
  type PrimaryMeetingContext,
} from '@balo/shared/meetings';
import { engagementsRepository } from '../engagements';
import { projectRequestsRepository } from '../project-requests';
import { requestExpertRelationshipsRepository } from '../request-expert-relationships';

/**
 * Re-exported, NOT redeclared. `@balo/shared/meetings` owns the shape; restating it here
 * would reintroduce in miniature exactly the second definition this module exists to remove.
 */
export type { MeetingContextOwner };

/**
 * THE REAL REPOSITORY BINDING for the pure rule. Each finder already filters
 * `deleted_at IS NULL`, which is the obligation `MeetingContextOwnerReads` assigns to its
 * injector — so `undefined` (missing OR soft-deleted) is the single not-found outcome.
 *
 * Wrapped in arrows rather than passed as bare method references so the repository object is
 * dereferenced at CALL time, not at module-init time.
 */
const REPOSITORY_READS = {
  findEngagement: (engagementId: string) => engagementsRepository.findById(engagementId),
  findProjectRequest: (projectRequestId: string) =>
    projectRequestsRepository.findById(projectRequestId),
  findRelationship: (relationshipId: string) =>
    requestExpertRelationshipsRepository.findById(relationshipId),
} satisfies MeetingContextOwnerReads;

/**
 * WHO OWNS THIS MEETING CONTEXT — the DB-BOUND WRAPPER around
 * `@balo/shared/meetings`'s `resolveContextOwner`. The per-context-type SWITCH is NOT here:
 * it lives once in the shared pure core, and `apps/api`'s `loadOwningParty` delegates to the
 * same core with the same reads. The discipline CLAUDE.md states for
 * `relationshipDeniesHosting` — "never write a second definition" — is what this shape buys.
 *
 * ⚠ IT IS A READ, NOT A GATE, AND THAT IS WHY IT MAY LIVE IN A REPOSITORY. It reports which
 * company owns the row and says NOTHING about whether the caller may see it. ADR-1029
 * forbids GATES in repositories, not cross-table reads; `_shared/consultation-projection.ts`
 * and `_shared/engagement-supertype.ts` are the shape precedent. Every caller MUST still run
 * its own capability check against the returned `companyId` / `expertProfileId` — calling
 * this and acting on a non-`undefined` result is NOT authorization.
 *
 * ⚠ THE SIGNATURE IS UNCHANGED BY THE HOIST — deliberately. `undefined` still collapses
 * "missing", "soft-deleted" and the (unreachable) unhandled label into ONE not-found answer,
 * so a gate can map every shape to a single denial literal without extra work. The richer
 * three-outcome result stays inside the core, where the one caller that needs to tell them
 * apart — the `apps/api` gate, which logs the impossible label — can reach it.
 *
 * ⚠ THE COMPILE-TIME EXHAUSTIVENESS WITNESS AND THE `log.warn` DELIBERATELY DO NOT LIVE
 * HERE. Both stay at the `apps/api` gate, and the reason is LOGGING LOCALITY: logging is a
 * service concern, a repository that notified would read against
 * `repositories-never-notify.test.ts`'s spirit, and the witness belongs beside the `log.warn`
 * it explains. A SEVENTH holder-bearing label fails closed to `undefined` here — the safe
 * direction — and stops `pnpm --filter api typecheck` at the api witness.
 *
 * ⚠ IT IS **NOT** BECAUSE THIS PACKAGE IS UNCHECKED. An earlier version of this note said a
 * witness here "would be checked by NO CI command". That is FALSE, and it was verified false
 * by probe: `@balo/db`'s `main`/`types` point at raw `./src/index.ts`, so `apps/api` compiles
 * the repository modules it imports as part of its OWN program — a deliberate type error added
 * to THIS file is reported verbatim by `apps/api`'s `tsc --noEmit`
 * (`../../packages/db/src/repositories/_shared/meeting-context-owner.ts(NN,N): error TS2322`).
 *
 * ⚠ THE SCOPE, STATED PRECISELY SO IT IS NOT OVERCLAIMED: only files REACHABLE FROM THE
 * CONSUMING APP'S IMPORT GRAPH are checked that way. `@balo/db`'s 29 pre-existing baseline
 * errors survive precisely because their four files are test-only and nothing in either app's
 * graph imports them. "This package has no `typecheck` script" (memory
 * `reference_db_shared_no_typecheck_lint_scripts`) remains true and still means an UNIMPORTED
 * file here is checked by nothing; it does not mean an imported one is.
 */
export async function resolveMeetingContextOwner(
  subject: PrimaryMeetingContext
): Promise<MeetingContextOwner | undefined> {
  const result = await resolveContextOwner(subject, REPOSITORY_READS);
  return result.outcome === 'resolved' ? result.owner : undefined;
}
