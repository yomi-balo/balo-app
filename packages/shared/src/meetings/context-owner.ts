/**
 * BAL-423 — WHO OWNS THIS MEETING CONTEXT, as a PURE RULE WITH INJECTED READS.
 *
 * ⚠ THIS MODULE EXISTS TO KILL A SECOND DEFINITION. The per-context-type mapping "a meeting
 * context → the party that owns it" was written twice: once in `apps/api`'s
 * `authorize-meeting-participation.ts` (`loadOwningParty`) and once in `@balo/db`'s
 * `repositories/_shared/meeting-context-owner.ts`. CLAUDE.md's own discipline for
 * `relationshipDeniesHosting` — "never write a second definition" — applies verbatim: two
 * copies that silently diverged would be strictly worse than one shared rule. The SWITCH now
 * lives here, ONCE, and both callers delegate to it.
 *
 * ── WHY INJECTED READS, AND NOT AN IMPORT OF `@balo/db` ────────────────────────
 *
 * `packages/shared` is PURE and dependency-free by construction — that is what lets
 * `apps/web` client bundles, `apps/api`'s tsup build and `@balo/db` itself all reach one
 * definition. Importing `@balo/db` here would invert the dependency graph (`@balo/db`
 * depends on `@balo/shared`) and drag `postgres` into every consumer's bundle (memory
 * `reference_balo_db_client_bundle_footgun`).
 *
 * ⚠ AND IT DELIBERATELY DOES **NOT** IMPORT `server-only`. A pure function over injected
 * async reads has no need for it, and adding a `server-only` subpath to `@balo/shared` is
 * a KNOWN CRASH: `apps/api`'s tsup bundles `platform=node` WITHOUT the `react-server`
 * condition, so the module typechecks, builds green, and then crash-loops Railway at
 * runtime (the PR #191 hazard). Do not add one here.
 *
 * The injection also buys the behaviour-preservation proof for the `apps/api` refactor:
 * that gate's test mocks `@balo/db` with a FACTORY LITERAL naming exactly six repositories,
 * and a vitest factory mock throws on any export it omits. Because `loadOwningParty` passes
 * the very repository functions it already imports (and the test already mocks), rather
 * than importing a new `@balo/db` export, `authorize-meeting-participation.test.ts` stays
 * green COMPLETELY UNCHANGED. That is the proof, not a convenience.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────────
 *
 * ⚠ IT IS A READ, NOT A GATE. It reports which company owns the row and says NOTHING about
 * whether the caller may see it. Every caller MUST still run its own capability check
 * against the returned `companyId` / `expertProfileId` — calling this and acting on a
 * `resolved` outcome is NOT authorization (ADR-1029).
 *
 * ⚠ `request_interaction` COSTS TWO READS, AND THERE IS NO SHORTCUT. A
 * `request_expert_relationships` row names an expert and a REQUEST, not a company — the
 * company lives on the request. Reading the relationship alone and inferring tenancy from
 * the expert would authorize by DELIVERY IDENTITY on the membership axis, which is the axis
 * confusion CLAUDE.md forbids.
 *
 * ⚠ SOFT-DELETE FILTERING IS THE INJECTED READ'S OBLIGATION, NOT THIS MODULE'S. Every
 * shipped caller passes repository finders that already filter `deleted_at IS NULL`, so
 * `undefined` (missing OR soft-deleted) collapses into the single `not_found` outcome —
 * which is what lets a gate answer both with one denial literal. A caller that injected an
 * unfiltered read would silently resolve tenancy from a deleted row; do not.
 */
import type { MeetingContextTypeWithHolder, PrimaryMeetingContext } from './guest-participation';

/**
 * The owning party of ONE resolved meeting context. Judgement-free: what the row says,
 * nothing more.
 */
export interface MeetingContextOwner {
  readonly companyId: string;
  /** `null` only for a `match`-routed `project_discovery`, which names nobody. */
  readonly expertProfileId: string | null;
}

/**
 * A row that names BOTH parties on itself. `engagements` and `project_requests` both do, so
 * ONE structural shape covers five of the six labels.
 *
 * ⚠ STRUCTURAL, NOT `@balo/db`'s ROW TYPE — that is the whole point of the injection. It is
 * deliberately WIDER than either table: `engagements.expert_profile_id` is NOT NULL on the
 * supertype (BAL-417) while `project_requests.expert_profile_id` is nullable, and `string`
 * is assignable to `string | null`, so one shape accepts both finders.
 */
export interface MeetingContextPartyRowLike {
  readonly companyId: string;
  readonly expertProfileId: string | null;
}

/**
 * A `request_expert_relationships` row as this rule sees it: it names an expert and a
 * REQUEST — never a company. Hence the second read.
 */
export interface MeetingContextRelationshipRowLike {
  readonly projectRequestId: string;
  readonly expertProfileId: string | null;
}

/**
 * The three reads the rule needs, injected by the caller.
 *
 * ⚠ EACH MUST ALREADY FILTER SOFT-DELETED ROWS (see the module docblock). `undefined` means
 * "no live row", and this module cannot tell the difference.
 */
export interface MeetingContextOwnerReads {
  /** Live engagement by id — the four engagement-grain labels. */
  readonly findEngagement: (
    engagementId: string
  ) => Promise<MeetingContextPartyRowLike | undefined>;
  /** Live project request by id — `project_discovery`, and the second hop of the third arm. */
  readonly findProjectRequest: (
    projectRequestId: string
  ) => Promise<MeetingContextPartyRowLike | undefined>;
  /** Live request↔expert relationship by id — `request_interaction`'s FIRST hop. */
  readonly findRelationship: (
    relationshipId: string
  ) => Promise<MeetingContextRelationshipRowLike | undefined>;
}

/**
 * The labels {@link resolveContextOwner}'s switch actually has an arm for.
 *
 * ⚠ `Extract`, NOT A BARE UNION, AND THAT IS LOAD-BEARING. Written as a plain union, a label
 * RENAMED in the database would leave a stale name here and nothing would notice. Written as
 * an `Extract` from the real label set, a rename silently DROPS the stale name from this
 * type, which widens {@link UnhandledMeetingContextType} away from `never` — and that is
 * exactly what trips the caller-side witness below.
 */
export type HandledMeetingContextType = Extract<
  MeetingContextTypeWithHolder,
  | 'case'
  | 'project_kickoff'
  | 'package_session'
  | 'retainer_checkin'
  | 'project_discovery'
  | 'request_interaction'
>;

/**
 * `never` today — and THAT IS THE POINT.
 *
 * ⚠ THIS TYPE IS THE COMPILE-TIME EXHAUSTIVENESS WITNESS, EXPORTED SO THE WITNESS CAN LIVE
 * AT THE CALLER. `apps/api`'s `loadOwningParty` writes `const exhaustive: never =
 * result.contextType` in its `unhandled` arm, so a SEVENTH holder-bearing
 * `meeting_context_type` label stops `pnpm --filter api typecheck` RIGHT THERE until an arm
 * is consciously written — the same guarantee the pre-refactor `default:` arm gave, at the
 * same command, on the same line count.
 *
 * ⚠ IT IS KEPT AT THE CALLER FOR **LOGGING LOCALITY**, NOT BECAUSE THIS PACKAGE IS
 * UNCHECKED. An earlier version of this note claimed a witness planted here "could fail
 * silently"; that is FALSE, and it was verified false by probe. `@balo/shared`'s `main`,
 * `types` and every `exports` subpath point at RAW `./src/*.ts`, so both apps compile these
 * files as part of their own program: a deliberate type error added to THIS file is reported
 * verbatim by BOTH `apps/api`'s `tsc --noEmit` and `apps/web`'s `check-types`, as
 * `../../packages/shared/src/meetings/context-owner.ts(NNN,N): error TS2322`. Both commands
 * really run in CI. The same probe reproduces for `@balo/db`.
 *
 * ⚠ THE PRECISE SCOPE OF THAT — do not overcorrect it into "these packages are fully
 * typechecked". ONLY FILES REACHABLE FROM THE CONSUMING APP'S IMPORT GRAPH are pulled into
 * its program. That is exactly why `@balo/db`'s 29 pre-existing baseline errors do NOT fail
 * `apps/api`'s typecheck: all four of those files (`expert-search.filters.test.ts`,
 * `_shared/credit-views.test.ts`, `request-status-coherence.integration.test.ts`,
 * `test/factories/promo-code.factory.ts`) are TEST-ONLY and nothing in either app's graph
 * imports them. A production module that an app imports IS checked; an unimported one is not.
 *
 * So the reason the witness sits at the `apps/api` gate is that the gate is where the
 * `log.warn` beside it belongs — logging is a service concern, and a pure rule with a logger
 * in it stops being pure. The witness travels WITH the log line it explains.
 */
export type UnhandledMeetingContextType = Exclude<
  MeetingContextTypeWithHolder,
  HandledMeetingContextType
>;

/**
 * Three outcomes, deliberately DISTINCT rather than collapsed into `T | undefined`.
 *
 * ⚠ `not_found` AND `unhandled` ARE THE SAME ANSWER TO A GATE AND A DIFFERENT ANSWER TO AN
 * OPERATOR. Both fail closed; only the second is a bug worth a `log.warn`. Splitting them
 * here is what lets the LOGGING — a service concern that must not live in a repository —
 * stay at the caller while the RULE lives here.
 */
export type ResolveContextOwnerResult =
  | { readonly outcome: 'resolved'; readonly owner: MeetingContextOwner }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'unhandled'; readonly contextType: UnhandledMeetingContextType };

/** The single not-found value. Frozen so a caller cannot mutate the shared result. */
const NOT_FOUND: ResolveContextOwnerResult = Object.freeze({ outcome: 'not_found' as const });

/**
 * Resolve ONE primary meeting context to its owning party, using the injected reads.
 *
 * TOTAL over the six holder-bearing labels. `admin` is unrepresentable by TYPE:
 * `PrimaryMeetingContext.contextType` is `MeetingContextTypeWithHolder`, and
 * `selectPrimaryMeetingContext` drops admin rows before one can be built.
 *
 * Never throws. Every failure is an outcome, because both callers are authorization gates
 * and a gate must never have to catch to stay safe.
 */
export async function resolveContextOwner(
  subject: PrimaryMeetingContext,
  reads: MeetingContextOwnerReads
): Promise<ResolveContextOwnerResult> {
  switch (subject.contextType) {
    // Engagement grain — `engagements.company_id` / `.expert_profile_id` are both NOT NULL
    // on the supertype (BAL-417), so the four labels share one branch.
    case 'case':
    case 'project_kickoff':
    case 'package_session':
    case 'retainer_checkin': {
      const engagement = await reads.findEngagement(subject.contextId);
      if (engagement === undefined) {
        return NOT_FOUND;
      }
      return {
        outcome: 'resolved',
        owner: {
          companyId: engagement.companyId,
          expertProfileId: engagement.expertProfileId,
        },
      };
    }

    // Request grain — the request itself carries the company.
    case 'project_discovery': {
      const request = await reads.findProjectRequest(subject.contextId);
      if (request === undefined) {
        return NOT_FOUND;
      }
      return {
        outcome: 'resolved',
        owner: { companyId: request.companyId, expertProfileId: request.expertProfileId },
      };
    }

    // Relationship grain — the company is one hop away, on the request. The EXPERT comes
    // from the relationship, the COMPANY from the request; mixing those up is the axis
    // confusion named in the module docblock.
    case 'request_interaction': {
      const relationship = await reads.findRelationship(subject.contextId);
      if (relationship === undefined) {
        return NOT_FOUND;
      }
      const request = await reads.findProjectRequest(relationship.projectRequestId);
      if (request === undefined) {
        return NOT_FOUND;
      }
      return {
        outcome: 'resolved',
        owner: { companyId: request.companyId, expertProfileId: relationship.expertProfileId },
      };
    }

    default:
      // Unreachable over the six holder-bearing labels — `subject.contextType` narrows to
      // `never` here today, which is precisely why the assignment below compiles. It is
      // handed OUT rather than logged: see `UnhandledMeetingContextType`.
      return { outcome: 'unhandled', contextType: subject.contextType };
  }
}
