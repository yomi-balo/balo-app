import { and, eq, isNull, sql } from 'drizzle-orm';
import type { db } from '../../client';
import { proposals, requestExpertRelationships } from '../../schema';

/**
 * ⚠ THE TRANSACTION HANDLE, NOT `DbExecutor` — AND THAT IS A DELIBERATE NARROWING (BAL-546,
 * orchestrator D17). `_shared/db-executor.ts`'s `DbExecutor` is `Database | TxHandle`, and the
 * base `db` handle type-checks against it while making `pg_advisory_xact_lock` a SILENT NO-OP
 * (an auto-commit statement takes the lock and releases it in the same breath, so nothing is
 * serialised and no gate fails). `acquireWalletLock` carries that hole and guards it only with
 * prose (`wallet-lock.ts`). This helper closes it at the TYPE level instead: `PgTransaction`
 * adds `rollback()` / `setTransaction()` plus protected members that the base `Database` does
 * not have, so `Database` is not assignable to it and `acquireRequestLock(db, …)` is a compile
 * error, not a runtime footgun. Mutation-verified: temporarily typing a call site as
 * `acquireRequestLock(db, …)` was confirmed to fail `pnpm typecheck` before this file shipped.
 */
type RequestLockTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Acquire the per-`projectRequestId` transaction-scoped advisory lock (BAL-546). Held from the
 * transaction's FIRST LOCK ACQUISITION to COMMIT/ROLLBACK, released automatically, and re-entrant
 * within the transaction (a nested re-take is free).
 *
 * ⚠ fix round R6 — "FIRST LOCK", NOT "first statement" (the docblock used to say the latter, and
 * it was untrue twice over). Two things can precede this call within the caller's transaction,
 * and neither takes a lock of any kind: (1) this function's own internal `SET LOCAL
 * lock_timeout` session-setting statement, issued immediately before the `pg_advisory_xact_lock`
 * call below; (2) in the two resolver wrappers further down this file
 * (`acquireRequestLockViaRelationshipTx` / `acquireRequestLockViaProposalTx`), one plain,
 * UNLOCKED `SELECT` of the denormalised `projectRequestId` (D8) that resolves the id this
 * function needs. Because that read takes no `FOR UPDATE` and no advisory lock, the claim that
 * survives is narrower but still true: this is the transaction's first LOCK, of any kind —
 * never its first statement.
 *
 * ⚠ WHAT THIS SERIALISES, NAMED EXACTLY. Every `@balo/db` transaction that writes TWO OR MORE
 * of `proposals` / `request_expert_relationships` / `project_requests` for ONE request, OR
 * INSERTS AN OPEN PROPOSAL onto a request, takes this as the transaction's first lock (fix
 * round R3 — the rule used to state only the first arm, and then named eleven writers including
 * two, `resubmit` and `createDraft`, that satisfy only the second: both are insert-based
 * producers of a live `proposals` row and nothing else in the same transaction, so a
 * membership test that checked only "two or more tables" would have wrongly excluded them —
 * which is the exact bug this ticket exists to fix, repeated at the rule's own definition).
 * The eleven: `proposalsRepository.submit`, `.createDraft`, `.promoteToSubmit`, `.accept`,
 * `.resubmit`; `projectRequestsRepository.close`; `requestExpertRelationshipsRepository.invite`,
 * `.declineTrack`, `.transitionStatus`; `expressionsOfInterestRepository.submit`;
 * `projectEngagementsRepository.materializeFromKickoff` — ELEVEN writers (orchestrator D13).
 * Because all of them queue on one per-request gate, no two of them ever interleave their
 * row-lock acquisition on the same request, so the documented row-lock orders (`accept`:
 * proposal → relationship → request; `promoteToSubmit`: relationship → request → proposal;
 * `close` / `declineTrack`: proposals → relationships → request; `materializeFromKickoff`:
 * request → relationships) can never form the AB/BA cycle that made them individually
 * deadlock-prone.
 *
 * ⚠ WHAT THIS DOES NOT PROVE. Not "the system is deadlock-free" — row locks are still locks.
 * What holds is narrower: all row-lock acquisition on a given request's proposals /
 * relationships / request happens underneath one globally-ordered per-request gate, so two
 * SERIALISED writers can never each hold a row the other needs. That is a property of the
 * CALLERS, not of the lock, and it stays true only for as long as every new multi-table
 * request-domain writer keeps taking this lock first (worded after
 * `apps/api/src/services/credit-session/end-session.ts:121-130`'s honest precedent, not after
 * the overstated one this ticket corrects at `apps/api/src/services/stripe/dispatch.ts`).
 *
 * ⚠ D9 — WRITERS ONLY. There is no read-side gate here, and a reader must not infer one: a
 * `SELECT` racing a serialised writer sees whatever READ COMMITTED gives it, before or after.
 *
 * ⚠ TWO ADVISORY-LOCK CLASSES NOW EXIST IN THE DATA LAYER (orchestrator D1/D16): this one and
 * `wallet-lock.ts`'s per-wallet class. They are disjoint TODAY — no repository file takes both
 * (mechanically checked, `invariants/an-account-hold-outlives-only-an-unpaid-balance.test.ts`),
 * and `acquireRequestLock` is not exported from `repositories/index.ts`, so no `apps/*`
 * transaction can reach it at all. That disjointness is a proof about FILES, not about
 * transactions that might span two files, one taking each class — that residual case is not
 * mechanically covered. Should a future transaction ever need both locks: **wallet lock FIRST,
 * then request lock.**
 *
 * ⚠ THE NAMESPACE PREFIX IS LOAD-BEARING (D1), NAMED PRECISELY (fix round F2). `hashtextextended`
 * is a 64-bit hash, so the prefix does not make collision with the wallet class impossible — it
 * removes only the SYSTEMATIC case, where the same UUID text is both a wallet id and a request
 * id and would otherwise hash to the identical key deterministically, every time. Without
 * `'project_request:' || requestId`, that case would be certain, not probabilistic. A RANDOM
 * 64-bit hash collision between the two classes remains at ~2⁻⁶⁴ — vanishingly unlikely, but not
 * structurally ruled out. Its consequence, should it ever occur, is spurious cross-class
 * serialisation and — given the wallet-first ordering rule is a written convention, not
 * mechanically enforced — a theoretical deadlock. Both classes otherwise share one flat 64-bit
 * `pg_advisory_xact_lock(bigint)` key space.
 *
 * ⚠ LONG-HOLD WARNING. `close()` is the longest holder of this lock — it holds it from its
 * first lock acquisition to COMMIT across ~10 steps. `materializeFromKickoff` is the single largest
 * transaction of the serialised set. Contention is per-`requestId`, so cross-request throughput
 * is unaffected. NEVER hold this lock across an external call
 * (`apps/api/src/services/credit/auto-topup.ts:23-24` is the explicit precedent for why not).
 *
 * ⚠ NEVER PUT A `Date` IN A RAW `sql` TEMPLATE (known Balo gotcha, `request-expert-
 * relationships.ts`'s `markNotSelectedByAward`). The interpolated value here is a UUID string,
 * so it does not apply — do not add one later.
 *
 * Mirrors `wallet-lock.ts:19-21`'s mechanics exactly: one-arg `bigint` overload (no two-arg
 * `(classid, objid)` form exists anywhere in this repo — do not introduce one), a Drizzle `sql`
 * tagged template with a `${}` placeholder (never `sql.raw`, never string concatenation) so the
 * statement goes on the wire as `$1`-parameterised and stays compatible with `prepare: false`
 * (`client.ts`, pinned by `invariants/production-client-disables-prepared-statements.test.ts`).
 *
 * ⚠⚠ fix round F1 — `SET LOCAL lock_timeout = '3s'` BOUNDS THE WAIT, SCOPED TO THIS LOCK ONLY.
 * Security found a MEDIUM availability regression: `createDraft` (BAL-546, D7) is reached from
 * the un-rate-limited proposal-autosave path (`save-proposal-draft.ts`), and before this fix it
 * waited on this advisory lock with NO timeout anywhere in the repo, pinning a pooled connection
 * for the lock holder's full cascade — `close()`'s ~10-step transaction is the longest holder.
 * Production's postgres-js pool is `max: 10` by default and the Supabase pooler's is shared
 * across tenants, so an unbounded wait here is a real resource-exhaustion surface, not a
 * theoretical one.
 *
 * The ruling (orchestrator, fix round): a SCOPED fix ONLY. A global `lock_timeout` on
 * `packages/db/src/client.ts` was rejected — it would also bound `wallet-lock.ts`'s waits and
 * change credit-system behaviour, which this ticket has no mandate to touch. `SET LOCAL` instead
 * of a session-wide `SET` is what keeps the change scoped to transactions that take THIS lock:
 * it resets automatically at COMMIT/ROLLBACK and never leaks onto a pooled connection's next
 * checkout.
 *
 * WHY A HARDCODED LITERAL, NEVER A BIND PARAMETER. Postgres does not accept a bind parameter
 * inside `SET` (`SET LOCAL lock_timeout = $1` is a syntax error) — the value MUST be a literal in
 * the SQL text. That is safe here ONLY because `'3s'` is a fixed constant baked into this file at
 * build time: no request input, no `requestId`, nothing caller-supplied reaches this statement.
 * Do not parameterise it later without re-deriving this safety argument.
 *
 * WHY 3 SECONDS. `close()` is the longest holder of this lock (~10 steps, see the LONG-HOLD
 * WARNING above) and is expected to complete well inside 1 second under normal load; 3 seconds
 * gives roughly 3x headroom over that before a waiter gives up, which keeps false-positive
 * timeouts rare during ordinary contention while still bounding how long a pooled connection can
 * sit blocked. This is a starting point, not a derived optimum — revisit if production telemetry
 * shows either spurious 55P03s (raise it) or connections pinned near the ceiling under load
 * (lower it).
 *
 * ⚠⚠ fix round R1(a) — THE TIMEOUT IS NARROWED TO THE GATE WAIT ONLY, NOT THE WHOLE TRANSACTION.
 * THIS SUPERSEDES an earlier version of this docblock that argued whole-transaction bounding was
 * the intended design — that argument is RETRACTED here, not kept alongside this one (a comment
 * that vouches for an invariant the code does not hold is worse than no comment). This function
 * resets `lock_timeout` to `DEFAULT` immediately after the advisory lock is acquired, so the 3s
 * bound applies ONLY to the wait for THIS one `pg_advisory_xact_lock` call; it never reaches any
 * row lock the caller takes afterwards.
 *
 * ⚠⚠ fix round R7 — `DEFAULT`, NOT THE LITERAL `0`. An earlier version of this function reset with
 * `SET LOCAL lock_timeout = 0`, reasoning that `0` is Postgres's own built-in default. That
 * reasoning was the defect: `0` is the COMPILED-IN default, not necessarily the EFFECTIVE one for
 * this session — `postgresql.conf`, `ALTER DATABASE … SET`, `ALTER ROLE … SET`, or a connection
 * pooler (plausible on Supabase, where the pooler is shared across tenants) can all set a
 * non-zero `lock_timeout` ahead of this transaction. Had any of those been in play, `= 0` would
 * not have RESTORED a protection — it would have SILENTLY DISABLED one, for the remainder of
 * every serialised writer's transaction, and this docblock would have been the thing vouching for
 * an invariant the code did not hold (the exact defect class this ticket exists to fix).
 * `SET LOCAL lock_timeout = DEFAULT` (equivalently, per Postgres semantics, `RESET lock_timeout`)
 * instead restores the value that was in effect at the START of this transaction/session — i.e.
 * the value `postgresql.conf` / `ALTER DATABASE` / `ALTER ROLE` / the pooler put there — accounting
 * for every one of those sources, not merely coinciding with them today. The claim that this
 * function "restores pre-PR behaviour" is therefore true of the PROPERTY (whatever `lock_timeout`
 * was before this function ran, it is that again after), not merely true of this repo's current
 * config (where nothing else happens to set `lock_timeout`, so `DEFAULT` and `0` coincide today).
 *
 * WHY NARROWED. The MEDIUM availability finding this fix answers is about writers QUEUING AT
 * THE GATE pinning a pooled connection — `createDraft`'s un-rate-limited autosave path
 * (`save-proposal-draft.ts`) waiting behind `close()`'s ~10-step cascade is the driving example.
 * That is what needs bounding, and only that. Bounding every subsequent row lock too (the
 * original, now-retracted shape of this fix) was broader than the ticket's mandate and had two
 * real side effects the narrowing removes:
 *   1. `close()`'s cascade would abort if ANY of its later row locks stalled past 3s — including
 *      behind writers this ticket does not serialise at all, like `updateDraft` or
 *      `requestSharedFilesRepository.share`, which can legitimately hold a row longer than 3s
 *      under ordinary load with no bug involved.
 *   2. A transaction that reached `acquireWalletLock` through another file (the residual,
 *      not-mechanically-covered case D16 names) would have run the WALLET lock itself under this
 *      3s bound — a credit-system behaviour change this ticket has no mandate to make (D1/D16).
 *
 * A timeout here raises Postgres SQLSTATE `55P03` (`lock_not_available`), mapped to the same
 * user-facing `CONCURRENT_RETRY_MESSAGE` as a `40P01` deadlock in
 * `apps/web/.../_actions/_shared/deadlock.ts` — from the caller's perspective both are
 * "something contended, retry" events.
 */
export async function acquireRequestLock(tx: RequestLockTx, requestId: string): Promise<void> {
  // Hardcoded literal, not a bind parameter — see the docblock above for why that is required
  // and why it is safe. Never interpolate anything derived from input into this statement.
  await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('project_request:' || ${requestId}, 0))`
  );
  // ⚠⚠ fix round R1(a)/R7 — RESET IMMEDIATELY, so the 3s bound covers ONLY the wait for the
  // advisory lock above and never any row lock the caller takes afterwards. `DEFAULT`, never the
  // literal `0` — see the docblock's R7 section for why `0` is the wrong value (it is Postgres's
  // compiled-in default, not necessarily this session's EFFECTIVE one) and why `DEFAULT` is what
  // actually restores the value in effect before this function ran.
  await tx.execute(sql`SET LOCAL lock_timeout = DEFAULT`);
}

/**
 * The shared tail of both resolver wrappers below: given an already-issued (but not yet
 * awaited-for-not-found) plain read of a `{ projectRequestId }` row, take the lock if the row
 * exists and return its id, or `undefined` if it does not. Extracted so the two wrappers'
 * SELECTs — genuinely different tables and columns — are the only thing that differs between
 * them (jscpd flagged the un-extracted pair as a near-clone).
 */
async function lockIfFound(
  tx: RequestLockTx,
  row: { projectRequestId: string } | undefined
): Promise<string | undefined> {
  if (row === undefined) return undefined;
  await acquireRequestLock(tx, row.projectRequestId);
  return row.projectRequestId;
}

/**
 * Resolve the request id from a `relationshipId` with a PLAIN, UNLOCKED read, then take the
 * per-request advisory lock. Returns `undefined` when the relationship is missing or
 * soft-deleted — the caller's own not-found guard fires unchanged, and no lock is taken.
 *
 * ⚠ D8 — THE WRITE-ONCE PREMISE. This pre-lock read is racy in principle (it runs before any
 * lock is held), and that is acceptable ONLY because `request_expert_relationships
 * .project_request_id` is written ONCE, at INSERT, and updated by no writer in this package —
 * pinned by `invariants/the-request-id-denormalisation-is-write-once.test.ts`. If that premise
 * ever stops holding, this resolver must be revisited.
 */
export async function acquireRequestLockViaRelationshipTx(
  tx: RequestLockTx,
  relationshipId: string
): Promise<string | undefined> {
  const [row] = await tx
    .select({ projectRequestId: requestExpertRelationships.projectRequestId })
    .from(requestExpertRelationships)
    .where(
      and(
        eq(requestExpertRelationships.id, relationshipId),
        isNull(requestExpertRelationships.deletedAt)
      )
    );
  return lockIfFound(tx, row);
}

/**
 * The proposal-side twin of {@link acquireRequestLockViaRelationshipTx}. Resolves the request id
 * from a `proposalId` with a plain, unlocked read of `proposals.project_request_id` (write-once
 * at INSERT — same D8 premise), then takes the per-request advisory lock. Returns `undefined`
 * for a missing/soft-deleted proposal, with no lock taken.
 */
export async function acquireRequestLockViaProposalTx(
  tx: RequestLockTx,
  proposalId: string
): Promise<string | undefined> {
  const [row] = await tx
    .select({ projectRequestId: proposals.projectRequestId })
    .from(proposals)
    .where(and(eq(proposals.id, proposalId), isNull(proposals.deletedAt)));
  return lockIfFound(tx, row);
}
