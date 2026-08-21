import { and, inArray, isNull } from 'drizzle-orm';
import {
  resolveContextOwner,
  selectPrimaryMeetingContext,
  type MeetingContextOwner,
  type MeetingContextOwnerReads,
  type PrimaryMeetingContext,
} from '@balo/shared/meetings';
import { db } from '../../client';
import { meetingContexts } from '../../schema';
import { companiesRepository } from '../companies';
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

/** The owning client party of ONE meeting, display-shaped. Name only — no id, no billing. */
export interface MeetingClientCompany {
  readonly companyId: string;
  readonly companyName: string;
}

/**
 * WHICH CLIENT COMPANY OWNS EACH OF THESE MEETINGS — the BATCHED form of the same rule
 * `resolveMeetingContextOwner` answers for one context. Built for BAL-416's conflict list,
 * which needs to name the client on up to `CONFLICT_DETAIL_LIMIT` conflicting consultations
 * in one round trip rather than one context read per row.
 *
 * ⚠ IT IS A READ, NOT A GATE (ADR-1029), exactly like its sibling above. It says nothing
 * about whether the caller may see these rows; BAL-416's caller has already scoped the
 * meeting ids to consultations the expert owns.
 *
 * ⚠ IT WRITES NO SECOND DEFINITION OF THE POLYMORPHIC WALK. Precedence and ambiguity come
 * from `selectPrimaryMeetingContext`; the context→party switch comes from
 * `resolveContextOwner` via the same `REPOSITORY_READS` binding above. Only the BATCHING and
 * the display-name hydration are new.
 *
 * A meeting whose contexts are ambiguous, absent or unresolvable is OMITTED from the map —
 * fail-closed. Callers must treat a missing key as "no company to name", never as an error.
 *
 * ⚠ `expectedExpertProfileId` (BAL-416 fix round 1, S2) — OPTIONAL, but every current caller
 * passes it. `meeting_contexts.context_id` has NO FK, NO CHECK and NO RLS, so nothing at the
 * data layer ties a walked context back to the expert whose consultations were listed; the
 * caller's `meetingIds` scoping only bounds the MEETING, not the CONTEXT — nothing at the data
 * layer ties a walked context to the expert whose consultations were listed (see the two
 * paragraphs below for what `attach` can and cannot do). When supplied, a meeting whose
 * resolved `owner.expertProfileId` does not match is OMITTED — the same fail-closed omission
 * the ambiguity and soft-delete arms already use, never a thrown error.
 *
 * ⚠ THE `attach` HAZARD THIS PARAMETER COULD NOT CLOSE IS NOW CLOSED FOR A SINGLE `attach`
 * CALL (BAL-469; fix round 2, R6). The scenario was: `meetingContextsRepository.attach` ran
 * only `assertProjectionExpertUnchangedTx`, a COHERENCE check (does the projected EXPERT stay
 * the same?) and never a check on the ANCHOR — so a tier-100 `case` context could attach to a
 * meeting created from a tier-50 `project_discovery`, PRESERVE the expert, and FLIP
 * `selectPrimaryMeetingContext`'s winner, and therefore the company this function names.
 * Comparing `owner.expertProfileId` here never caught it: the expert is unchanged by
 * construction of the scenario.
 *
 * `attach` now also runs `assertPrimaryContextUnchangedTx`, which refuses any single insert
 * that REPOINTS the primary from one resolvable context to a different one. Because the
 * owning company is a pure function of the primary context, no ONE `attach` can move a meeting
 * from naming company X to naming company Y. An attach that makes the primary AMBIGUOUS is
 * still allowed and is still safe HERE: `resolveOwnerEntry` omits an ambiguous meeting, so
 * this function names no company at all rather than the wrong one.
 *
 * ⚠ `detach` IS A SEPARATE WRITER OF `meeting_contexts` AND CARRIES NO SUCH GUARD — so the
 * per-call guarantee above does NOT compose into a per-meeting one. Detaching the row that is
 * currently primary can repoint it on its own (the tier-50 row underneath is promoted), and an
 * `attach`-to-ambiguous followed by a `detach` of the original winner reaches the exact X → Y
 * flip AC 1 forbids, in two individually-permitted steps. See `detach`'s own docblock in
 * `meeting-contexts.ts` for the full residual; it is closed for `attach` alone, not for the
 * meeting's lifecycle.
 *
 * ⚠ NOR DOES IT CLOSE MEMBERSHIP, ONLY THE ANCHOR. `listMeetingsForContext` matches ANY live
 * context row regardless of tier, so an `attach` of a lower-tier context under a victim's
 * tier-100 primary still succeeds (it never repoints) and still hands the attacher a reverse
 * read of that victim meeting through the context they legitimately hold. That obligation is
 * the caller's `hasCapability` check, stated on `attach`'s own docblock — this guard was never
 * meant to, and does not, close it either.
 *
 * ⚠ THE PARAMETER STILL EARNS ITS KEEP AND IS NOT MADE REDUNDANT BY THAT GUARD. It is a
 * READ-side defence over rows `attach` never wrote: raw inserts, fixtures, pre-BAL-469 rows,
 * and any future second writer of `meeting_contexts` — including `detach`, per the residual
 * above. `context_id` still has NO FK, NO CHECK and NO RLS, so nothing at the data layer ties
 * a walked context back to the expert whose consultations were listed. Every current caller
 * passes it; keep passing it.
 */
type OwnerEntry = { meetingId: string; companyId: string };

function groupRowsByMeeting<T extends { meetingId: string }>(rows: readonly T[]): Map<string, T[]> {
  const rowsByMeeting = new Map<string, T[]>();
  for (const row of rows) {
    const existing = rowsByMeeting.get(row.meetingId);
    if (existing === undefined) {
      rowsByMeeting.set(row.meetingId, [row]);
    } else {
      existing.push(row);
    }
  }
  return rowsByMeeting;
}

/**
 * ONE meeting's owner, resolved via the same precedence/ambiguity/party pipeline as
 * `resolveMeetingContextOwner`, and OMITTED (`null`) if ambiguous, unresolvable, or its
 * owner doesn't match `expectedExpertProfileId` (see the `attach`-hazard note above).
 */
async function resolveOwnerEntry(
  meetingId: string,
  meetingRows: Parameters<typeof selectPrimaryMeetingContext>[0],
  expectedExpertProfileId: string | undefined
): Promise<OwnerEntry | null> {
  const selection = selectPrimaryMeetingContext(meetingRows);
  if (!selection.ok) {
    return null;
  }
  const result = await resolveContextOwner(selection.context, REPOSITORY_READS);
  if (result.outcome !== 'resolved') {
    return null;
  }
  if (
    expectedExpertProfileId !== undefined &&
    result.owner.expertProfileId !== expectedExpertProfileId
  ) {
    return null;
  }
  return { meetingId, companyId: result.owner.companyId };
}

async function fetchNameByCompanyId(companyIds: ReadonlySet<string>): Promise<Map<string, string>> {
  const companyNames = await Promise.all(
    [...companyIds].map(async (companyId) => {
      const company = await companiesRepository.findNameById(companyId);
      return company === undefined ? null : { companyId, companyName: company.name };
    })
  );
  const nameByCompanyId = new Map<string, string>();
  for (const company of companyNames) {
    if (company !== null) {
      nameByCompanyId.set(company.companyId, company.companyName);
    }
  }
  return nameByCompanyId;
}

export async function resolveClientCompaniesForMeetings(
  meetingIds: readonly string[],
  expectedExpertProfileId?: string
): Promise<Map<string, MeetingClientCompany>> {
  if (meetingIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({
      meetingId: meetingContexts.meetingId,
      contextType: meetingContexts.contextType,
      contextId: meetingContexts.contextId,
    })
    .from(meetingContexts)
    .where(
      and(inArray(meetingContexts.meetingId, [...meetingIds]), isNull(meetingContexts.deletedAt))
    );

  const rowsByMeeting = groupRowsByMeeting(rows);

  // Resolve each meeting's owner in parallel — precedence/ambiguity via
  // `selectPrimaryMeetingContext`, then the party via `resolveContextOwner`.
  const ownerEntries = await Promise.all(
    [...rowsByMeeting.entries()].map(([meetingId, meetingRows]) =>
      resolveOwnerEntry(meetingId, meetingRows, expectedExpertProfileId)
    )
  );

  const distinctCompanyIds = new Set<string>();
  for (const entry of ownerEntries) {
    if (entry !== null) {
      distinctCompanyIds.add(entry.companyId);
    }
  }

  const nameByCompanyId = await fetchNameByCompanyId(distinctCompanyIds);

  const result = new Map<string, MeetingClientCompany>();
  for (const entry of ownerEntries) {
    if (entry === null) continue;
    const companyName = nameByCompanyId.get(entry.companyId);
    if (companyName === undefined) continue;
    result.set(entry.meetingId, { companyId: entry.companyId, companyName });
  }
  return result;
}
