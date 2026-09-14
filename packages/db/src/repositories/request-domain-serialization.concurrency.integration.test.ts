import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from '../schema';
import { _setDb, type Database } from '../client';
import { createConcurrentDb } from '../test/concurrent-client';
import {
  expertDraftFactory,
  projectRequestFactory,
  proposalFactory,
  requestExpertRelationshipFactory,
  userFactory,
} from '../test/factories';
import { acquireRequestLock } from './_shared/request-lock';
import { OPEN_PROPOSAL_STATUSES, proposalsRepository, type ProposalStatus } from './proposals';
import { projectRequestsRepository, type CloseRequestResult } from './project-requests';
import {
  requestExpertRelationshipsRepository,
  RequestClosedError,
  type RelationshipStatus,
} from './request-expert-relationships';
import { projectEngagementsRepository } from './project-engagements';

/**
 * ⚠ THIS FILE MUST NOT CONTAIN THE LITERAL `pg_advisory` IN CODE (D10/D15, house rule pinned by
 * `invariants/an-account-hold-outlives-only-an-unpaid-balance.test.ts`'s amended lock-class scan).
 * It reaches the per-request advisory lock ONLY through the imported `acquireRequestLock` symbol
 * and observes blocking through `pg_blocking_pids` (a different string). Prose in this docblock
 * may name the SQL function freely — comments are stripped by the scan.
 *
 * BAL-546 — THE REAL INTERLEAVING PROOF for the advisory-lock discipline (§1) and the union
 * re-read (§2). Every OTHER concurrency suite in this package uses TWO contenders and a warden;
 * this one needs FOUR real Postgres backends, because "the lock is taken before any row lock"
 * (Group A) requires a GATE that holds ONLY the advisory lock — no row lock at all — so that a
 * writer which took a row lock FIRST would slip past it undetected.
 *
 * ⚠ `createConcurrentDb`, NOT raw `postgres(url, { max: 1 })` (D10). The five pre-existing
 * concurrency suites in this package omit `prepare: false`, which is the named-COMMIT
 * silent-rollback footgun (`packages/db/src/client.ts`'s docblock). `createConcurrentDb` spreads
 * it first.
 *
 * ⚠ NEVER A `sleep`. Every interleaving below is forced by issuing a statement and then polling
 * `pg_blocking_pids(waiterPid)` until it names the holder, throwing loudly on exhaustion rather
 * than degrading into an unforced (and ~77%-of-the-time sequential) race.
 */

type PgClient = ReturnType<typeof postgres>;
/** The active transaction handle every writer under test receives — mirrors `RequestLockTx` in
 *  `_shared/request-lock.ts`. Deliberately NOT `DbExecutor`: passing the base `Database` to
 *  `acquireRequestLock` must stay a compile error (D17), so this file's own row-lock-holding
 *  helper is typed the same narrow way. */
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const BLOCK_POLL_INTERVAL_MS = 25;
// ⚠ fix round F7 — RAISED FROM 400 FOR CI HEADROOM. 400 * 25ms = 10s was tuned against local
// runs; a reviewer hit budget exhaustion under CI/machine load where the contender was never
// even SCHEDULED in time, not because the lock wasn't taken. The loop still exits the instant
// blocking is observed, so this only widens the ceiling for a slow machine — it costs nothing
// on the common path.
const BLOCK_POLL_ATTEMPTS = 800;

let gateClient: PgClient;
let aClient: PgClient;
let bClient: PgClient;
let wardenClient: PgClient;
let gateDb: Database;
let aDb: Database;
let bDb: Database;
let wardenDb: Database;
let gatePid: number;
let aPid: number;
let bPid: number;

const openHolds: Array<() => Promise<void>> = [];
const inFlight: Array<Promise<unknown>> = [];
/** Every project request this file COMMITS. Deleting it cascades to
 *  `request_expert_relationships` and `proposals`. */
const seededRequestIds: string[] = [];

/**
 * Settlement state for a `contend()`-tracked promise, keyed by the exact promise reference
 * `contend` returns (fix round F7). Lets {@link waitUntilBlockedBy} tell, on budget exhaustion,
 * "the contender already settled — this isn't a serialization failure" from "the contender is
 * still pending and genuinely never blocked".
 */
type ContenderSettlement =
  | { status: 'pending' }
  | { status: 'fulfilled' }
  | { status: 'rejected'; reason: unknown };

/** A mutable box so `contend()` can swap the settlement value in place without fighting the
 *  discriminated union's readonly-by-narrowing shape. */
interface ContenderSettlementBox {
  value: ContenderSettlement;
}

const contenderSettlements = new WeakMap<Promise<unknown>, ContenderSettlementBox>();

/** Describe a rejection reason for an error message without ever throwing while formatting it. */
function describeReason(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  if (typeof reason === 'object' && reason !== null && 'code' in reason) {
    return `object with code ${String((reason as { code: unknown }).code)}`;
  }
  return String(reason);
}

function contend<T>(statement: Promise<T>): Promise<T> {
  const box: ContenderSettlementBox = { value: { status: 'pending' } };
  contenderSettlements.set(statement, box);
  // A SEPARATE `.then` chain records settlement without altering what `statement` itself
  // resolves/rejects to — callers still await `statement` (the return value below) for the
  // real result, this is a side observer only.
  const observed = statement.then(
    () => {
      box.value = { status: 'fulfilled' };
    },
    (reason: unknown) => {
      box.value = { status: 'rejected', reason };
    }
  );
  inFlight.push(observed);
  return statement;
}

async function backendPid(client: PgClient): Promise<number> {
  const rows = await client<{ pid: number }[]>`select pg_backend_pid() as pid`;
  const [row] = rows;
  if (row === undefined) throw new Error('pg_backend_pid() returned no row');
  return row.pid;
}

/**
 * Block until Postgres reports `waiterPid` as waiting on a lock held by `holderPid`. THIS CALL
 * IS THE DETERMINISM — there is nothing to `expect()` afterwards. Exhausting the budget THROWS.
 *
 * ⚠ fix round F7 — `contender`, WHEN PASSED, DISAMBIGUATES THE EXHAUSTION MESSAGE. Budget
 * exhaustion has THREE distinct causes, and before this fix-round they all threw the same
 * "the serialization this test proves did not hold" — which sent a reviewer chasing the wrong
 * one after hitting cause 3 under load: (1) the lock genuinely was never taken — a real
 * regression; (2) the contender REJECTED before it ever reached the lock (a seed/setup bug, not
 * a locking bug); (3) the contender is still pending, but Postgres never scheduled it in time
 * for `pg_blocking_pids` to observe the block — a machine-load flake, not a code defect. Passing
 * the `contend()`-tracked promise here lets the message name (2) explicitly and separate it from
 * (1)/(3), which remain indistinguishable from this vantage point (both look "still pending") —
 * see `BLOCK_POLL_ATTEMPTS`'s own docblock for the mitigation for (3). This throw-on-exhaustion
 * behaviour is deliberate and MUST stay a throw, never softened to a warning or a skip — a
 * silently-skipped assertion here would prove nothing next time either.
 */
async function waitUntilBlockedBy(
  waiterPid: number,
  holderPid: number,
  contender?: Promise<unknown>
): Promise<void> {
  for (let attempt = 0; attempt < BLOCK_POLL_ATTEMPTS; attempt += 1) {
    const rows = await wardenClient<{ blockers: number[] }[]>`
      select coalesce(pg_blocking_pids(${waiterPid}::int), '{}'::int[]) as blockers
    `;
    const [row] = rows;
    if (row !== undefined && row.blockers.includes(holderPid)) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, BLOCK_POLL_INTERVAL_MS);
    });
  }
  const budgetMs = BLOCK_POLL_ATTEMPTS * BLOCK_POLL_INTERVAL_MS;
  const settlement = contender === undefined ? undefined : contenderSettlements.get(contender);
  if (settlement !== undefined && settlement.value.status === 'rejected') {
    throw new Error(
      `backend ${waiterPid} never blocked on backend ${holderPid} within ${budgetMs}ms — but its ` +
        `contender already settled: REJECTED with ${describeReason(settlement.value.reason)}. ` +
        'This is NOT evidence the serialization failed — the contender errored out (likely in ' +
        'setup/seeding) before it ever reached the lock, so it was never going to block. Fix the ' +
        'rejection, not this wait.'
    );
  }
  if (settlement !== undefined && settlement.value.status === 'fulfilled') {
    throw new Error(
      `backend ${waiterPid} never blocked on backend ${holderPid} within ${budgetMs}ms — but its ` +
        'contender already settled: FULFILLED. The write raced ahead and completed WITHOUT ever ' +
        'blocking on the expected lock — this IS evidence the serialization did not hold.'
    );
  }
  throw new Error(
    `backend ${waiterPid} never blocked on backend ${holderPid} within ${budgetMs}ms, and its ` +
      'contender is still pending (never settled either). Either the serialization this test ' +
      "proves did not hold, or the poll budget was too small for this machine's scheduling — " +
      'see `BLOCK_POLL_ATTEMPTS`.'
  );
}

interface HeldTransaction<T> {
  result: T;
  commit: () => Promise<void>;
}

/** Run ONE call inside a transaction on `target` and leave it OPEN, holding its locks. */
async function holdOpen<T>(
  target: Database,
  run: (tx: Tx) => Promise<T>
): Promise<HeldTransaction<T>> {
  let release: (() => void) | undefined;
  let settle: ((value: T) => void) | undefined;
  let fail: ((reason: unknown) => void) | undefined;
  const ready = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  let txError: unknown;
  const txSettled = target
    .transaction(async (tx) => {
      const value = await run(tx);
      settle?.(value);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    })
    .catch((error: unknown) => {
      txError = error;
      fail?.(error);
    });

  const result = await ready;
  const held: HeldTransaction<T> = {
    result,
    commit: async () => {
      release?.();
      await txSettled;
      if (txError !== undefined) throw txError;
    },
  };
  openHolds.push(held.commit);
  return held;
}

/**
 * ⚠ WHY THIS WORKS, AND WHAT WOULD BREAK IT. `db` is a `let` export (`client.ts`) and every
 * repository imports it as an ES live binding, so `db.transaction(` is resolved at CALL time.
 * Every writer this file drives reaches `return db.transaction(` with NO `await` before it, so
 * binding `target` immediately before the call is synchronous and race-free. If a writer ever
 * gains an `await` above its `db.transaction(`, this mis-binds silently — the symptom is the
 * `waitUntilBlockedBy` budget timing out, never a wrong answer.
 */
function runOn<T>(target: Database, call: () => Promise<T>): Promise<T> {
  _setDb(target);
  return call();
}

function isDeadlock(outcome: PromiseSettledResult<unknown>): boolean {
  if (outcome.status !== 'rejected') return false;
  const reason: unknown = outcome.reason;
  return (
    typeof reason === 'object' && reason !== null && 'code' in reason && reason.code === '40P01'
  );
}

/**
 * Issue `work` on `target`, confirm it has blocked on whatever `gate` currently holds, and
 * return the still-PENDING promise (not yet awaited) — every Group A/B/C case that races a
 * writer against a held request-domain lock shares this exact shape, so it lives here once
 * rather than many times over (jscpd flagged the un-extracted repetition).
 *
 * ⚠ WRAPPED IN AN OBJECT, DELIBERATELY — `{ contender }`, NOT the bare promise. An `async`
 * function that `return`s a promise value AUTO-FLATTENS it: the outer promise would not settle
 * until `contender` itself resolves, which is exactly the deadlock this helper exists to avoid
 * (the CALLER only releases the gate — the one thing `contender` is waiting on — AFTER this
 * helper returns). Wrapping in a plain object is what keeps `contender` a still-pending value.
 */
async function issueContenderBlockedOnGate<T>(
  target: Database,
  targetPid: number,
  work: () => Promise<T>
): Promise<{ contender: Promise<T> }> {
  const contender = contend(runOn(target, work));
  await waitUntilBlockedBy(targetPid, gatePid, contender);
  return { contender };
}

/** The `close()` special case of {@link issueContenderBlockedOnGate} — every case in this file
 *  that races something against a held lock uses `close()` as (at least) one of the two sides. */
async function issueCloseBlockedOnGate(
  target: Database,
  targetPid: number,
  requestId: string,
  actorUserId: string
): Promise<{ closing: Promise<CloseRequestResult> }> {
  const { contender } = await issueContenderBlockedOnGate(target, targetPid, () =>
    projectRequestsRepository.close({
      requestId,
      actorUserId,
      actorKind: 'balo',
      reason: 'unfilled',
      note: null,
    })
  );
  return { closing: contender };
}

/**
 * Release `held`, let `closing` and `contender` race to their settled outcomes, and assert
 * NEITHER surfaces a Postgres deadlock (40P01) — the shared tail of every Group B case. Returns
 * both outcomes so each test can still assert its own order-independent facts on them.
 */
async function settleRaceAgainstGate<T>(
  held: HeldTransaction<unknown>,
  closing: Promise<CloseRequestResult>,
  contender: Promise<T>
): Promise<{
  closeOutcome: PromiseSettledResult<CloseRequestResult>;
  contenderOutcome: PromiseSettledResult<T>;
}> {
  await held.commit();
  const [closeOutcome, contenderOutcome] = await Promise.allSettled([closing, contender]);
  expect(isDeadlock(closeOutcome)).toBe(false);
  expect(isDeadlock(contenderOutcome)).toBe(false);
  return { closeOutcome, contenderOutcome };
}

// ── Seeding — all committed via `wardenDb` ──────────────────────────────────────────────

async function seedActorId(): Promise<string> {
  _setDb(wardenDb);
  return (await userFactory()).id;
}

async function seedBareRequest(): Promise<{ requestId: string; expertProfileId: string }> {
  _setDb(wardenDb);
  const request = await projectRequestFactory();
  seededRequestIds.push(request.id);
  if (request.expertProfileId === null) {
    throw new Error('seeded direct request has no expertProfileId');
  }
  return { requestId: request.id, expertProfileId: request.expertProfileId };
}

async function seedRelationship(
  status: RelationshipStatus
): Promise<{ requestId: string; relationshipId: string; expertProfileId: string }> {
  _setDb(wardenDb);
  const inviter = await userFactory();
  const { relationship, projectRequestId, expertProfileId } =
    await requestExpertRelationshipFactory({
      invitedByUserId: inviter.id,
      values: { status },
    });
  seededRequestIds.push(projectRequestId);
  return { requestId: projectRequestId, relationshipId: relationship.id, expertProfileId };
}

/** A relationship at `proposal_requested` with a coherent `draft` proposal — `promoteToSubmit`'s
 *  input shape. `tm` / zero price / no milestones is the cheapest coherent header (mirrors
 *  `proposals.integration.test.ts`'s own `promoteToSubmit` fixture). */
async function seedDraftProposalForPromote(): Promise<{
  requestId: string;
  relationshipId: string;
  proposalId: string;
}> {
  _setDb(wardenDb);
  const inviter = await userFactory();
  const rel = await requestExpertRelationshipFactory({
    invitedByUserId: inviter.id,
    values: { status: 'proposal_requested' },
  });
  const draft = await proposalFactory({
    relationship: rel,
    values: {
      status: 'draft',
      pricingMethod: 'tm',
      priceCents: 0,
      depositCents: 25_000,
      rateCents: 18_000,
      cadence: 'monthly',
    },
  });
  seededRequestIds.push(rel.projectRequestId);
  return {
    requestId: rel.projectRequestId,
    relationshipId: rel.relationship.id,
    proposalId: draft.proposal.id,
  };
}

/** A relationship with a CURRENT proposal at `changes_requested` — `resubmit`'s input shape. */
async function seedChangesRequestedProposal(): Promise<{
  requestId: string;
  relationshipId: string;
  proposalId: string;
}> {
  _setDb(wardenDb);
  const inviter = await userFactory();
  const rel = await requestExpertRelationshipFactory({
    invitedByUserId: inviter.id,
    values: { status: 'proposal_submitted' },
  });
  const proposal = await proposalFactory({
    relationship: rel,
    values: { status: 'changes_requested', isCurrent: true },
  });
  seededRequestIds.push(rel.projectRequestId);
  return {
    requestId: rel.projectRequestId,
    relationshipId: rel.relationship.id,
    proposalId: proposal.proposal.id,
  };
}

/** A request with TWO live tracks: R1 carries an OPEN `draft` proposal P1 (the row `gate` locks);
 *  R2 carries none — the partial unique `proposal_current_per_relationship_idx` forbids a second
 *  CURRENT proposal on R1, so the mid-race committed proposal must land on R2 instead. */
async function seedTwoTrackRequestWithOneOpenProposal(): Promise<{
  requestId: string;
  actorUserId: string;
  proposalId: string;
  secondRelationshipId: string;
  secondExpertProfileId: string;
}> {
  _setDb(wardenDb);
  const request = await projectRequestFactory();
  seededRequestIds.push(request.id);
  if (request.expertProfileId === null) {
    throw new Error('seeded direct request has no expertProfileId');
  }
  const inviter = await userFactory();
  const r1 = await requestExpertRelationshipFactory({
    projectRequestId: request.id,
    expertProfileId: request.expertProfileId,
    invitedByUserId: inviter.id,
    values: { status: 'proposal_submitted' },
  });
  const p1 = await proposalFactory({
    relationship: r1,
    values: {
      status: 'draft',
      pricingMethod: 'tm',
      priceCents: 0,
      depositCents: 25_000,
      rateCents: 18_000,
      cadence: 'monthly',
    },
  });
  const expert2 = await expertDraftFactory();
  const r2 = await requestExpertRelationshipFactory({
    projectRequestId: request.id,
    expertProfileId: expert2.id,
    invitedByUserId: inviter.id,
    values: { status: 'proposal_submitted' },
  });

  return {
    requestId: request.id,
    actorUserId: inviter.id,
    proposalId: p1.proposal.id,
    secondRelationshipId: r2.relationship.id,
    secondExpertProfileId: r2.expertProfileId,
  };
}

async function insertCommittedRelationship(input: {
  projectRequestId: string;
  expertProfileId: string;
  invitedByUserId: string;
  status: RelationshipStatus;
}): Promise<string> {
  const [row] = await wardenDb
    .insert(schema.requestExpertRelationships)
    .values(input)
    .returning({ id: schema.requestExpertRelationships.id });
  if (row === undefined) throw new Error('relationship insert failed');
  return row.id;
}

async function insertCommittedProposal(input: {
  relationshipId: string;
  projectRequestId: string;
  expertProfileId: string;
  status: ProposalStatus;
  isCurrent: boolean;
}): Promise<string> {
  const [row] = await wardenDb
    .insert(schema.proposals)
    .values({
      relationshipId: input.relationshipId,
      projectRequestId: input.projectRequestId,
      expertProfileId: input.expertProfileId,
      status: input.status,
      isCurrent: input.isCurrent,
      pricingMethod: 'tm',
      priceCents: 0,
      overview: '<p>Race fixture.</p>',
    })
    .returning({ id: schema.proposals.id });
  if (row === undefined) throw new Error('proposal insert failed');
  return row.id;
}

// ⚠ fix round R7 (Qodo) — all three readers below select from soft-deletable tables and now
// filter `deletedAt IS NULL`, matching the production repositories they stand in for. Without
// it, a fixture or a concurrently-affected row that got soft-deleted mid-race would still come
// back and skew the assertion built on top of it — Qodo's "Deleted rows skew race assertions".
async function readRequest(id: string) {
  const [row] = await wardenDb
    .select()
    .from(schema.projectRequests)
    .where(and(eq(schema.projectRequests.id, id), isNull(schema.projectRequests.deletedAt)));
  return row;
}

async function readRelationship(id: string) {
  const [row] = await wardenDb
    .select()
    .from(schema.requestExpertRelationships)
    .where(
      and(
        eq(schema.requestExpertRelationships.id, id),
        isNull(schema.requestExpertRelationships.deletedAt)
      )
    );
  return row;
}

async function readProposal(id: string) {
  const [row] = await wardenDb
    .select()
    .from(schema.proposals)
    .where(and(eq(schema.proposals.id, id), isNull(schema.proposals.deletedAt)));
  return row;
}

// ⚠ fix round R7 (Qodo) — BOTH helpers below are named "live"/were missing the `deletedAt`
// filter their names promise. Every production read this suite compares against filters
// `deletedAt IS NULL` (the soft-delete convention, CLAUDE.md); a test helper that doesn't would
// silently pass a soft-deleted row through as "live" and could mask a real regression.
async function liveRelationshipsForRequest(requestId: string) {
  return wardenDb
    .select()
    .from(schema.requestExpertRelationships)
    .where(
      and(
        eq(schema.requestExpertRelationships.projectRequestId, requestId),
        isNull(schema.requestExpertRelationships.deletedAt)
      )
    );
}

async function openProposalsForRequest(requestId: string) {
  const rows = await wardenDb
    .select()
    .from(schema.proposals)
    .where(
      and(eq(schema.proposals.projectRequestId, requestId), isNull(schema.proposals.deletedAt))
    );
  return rows.filter((row) => (OPEN_PROPOSAL_STATUSES as readonly string[]).includes(row.status));
}

/** Runs the C2/C3 race once and returns the close() result plus both proposal ids, so both
 *  `it`s can assert different facts about ONE race without duplicating its orchestration. */
async function raceProposalCommitAgainstCloseSnapshot(): Promise<{
  result: CloseRequestResult;
  proposalIds: [string, string];
}> {
  const seed = await seedTwoTrackRequestWithOneOpenProposal();

  const held = await holdOpen(gateDb, (tx) =>
    tx.select().from(schema.proposals).where(eq(schema.proposals.id, seed.proposalId)).for('update')
  );

  const { closing } = await issueCloseBlockedOnGate(aDb, aPid, seed.requestId, seed.actorUserId);

  const p2Id = await insertCommittedProposal({
    relationshipId: seed.secondRelationshipId,
    projectRequestId: seed.requestId,
    expertProfileId: seed.secondExpertProfileId,
    status: 'submitted',
    isCurrent: true,
  });

  await held.commit();

  const result = await closing;
  return { result, proposalIds: [seed.proposalId, p2Id] };
}

beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests must be run via "pnpm test:integration".'
    );
  }
  ({ db: gateDb, client: gateClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: aDb, client: aClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: bDb, client: bClient } = createConcurrentDb(url, { max: 1 }));
  ({ db: wardenDb, client: wardenClient } = createConcurrentDb(url, { max: 1 }));

  gatePid = await backendPid(gateClient);
  aPid = await backendPid(aClient);
  bPid = await backendPid(bClient);

  // ⚠ THE PREMISE OF THE FILE, ASSERTED. Four DISTINCT backends, or `pg_blocking_pids` (which
  // never names a backend as blocking itself) burns the poll budget and blames the lock.
  expect(new Set([gatePid, aPid, bPid]).size).toBe(3);
});

afterEach(async () => {
  // ⚠ ORDER IS LOAD-BEARING — same as the sibling suite. Release stranded holds first, drain
  // contenders, THEN delete.
  for (const commit of openHolds.splice(0)) {
    await commit().catch(() => undefined);
  }
  await Promise.allSettled(inFlight.splice(0));

  const requestIds = seededRequestIds.splice(0);
  if (requestIds.length === 0) return;

  const relationships = await wardenDb
    .select({ id: schema.requestExpertRelationships.id })
    .from(schema.requestExpertRelationships)
    .where(inArray(schema.requestExpertRelationships.projectRequestId, requestIds))
    .catch(() => []);

  // `audit_events` has no FK to either table — the request delete below does NOT cascade to it.
  if (relationships.length > 0) {
    await wardenDb
      .delete(schema.auditEvents)
      .where(
        inArray(
          schema.auditEvents.entityId,
          relationships.map((r) => r.id)
        )
      )
      .catch(() => undefined);
  }
  await wardenDb
    .delete(schema.auditEvents)
    .where(inArray(schema.auditEvents.entityId, requestIds))
    .catch(() => undefined);

  // Cascades to `request_expert_relationships` and `proposals`. Users/expert profiles are
  // deliberately leaked (all plain `platformRole: 'user'` — see `seedActorId`/`seedRelationship`
  // — the same measured choice `request-shared-files.concurrency.integration.test.ts` documents).
  await wardenDb
    .delete(schema.projectRequests)
    .where(inArray(schema.projectRequests.id, requestIds))
    .catch(() => undefined);
});

afterAll(async () => {
  await Promise.all([
    gateClient?.end({ timeout: 5 }),
    aClient?.end({ timeout: 5 }),
    bClient?.end({ timeout: 5 }),
    wardenClient?.end({ timeout: 5 }),
  ]);
});

// ── Group A — the lock is taken, and it is taken FIRST ──────────────────────────────────

describe('Group A — the per-request advisory lock is taken before any row lock', () => {
  it('close() blocks on the per-request advisory lock before it takes a single row lock', async () => {
    const seed = await seedBareRequest();
    const actorUserId = await seedActorId();

    const held = await holdOpen(gateDb, (tx) => acquireRequestLock(tx, seed.requestId));

    const { closing } = await issueCloseBlockedOnGate(aDb, aPid, seed.requestId, actorUserId);

    await held.commit();

    const result = await closing;
    expect(result.request.status).toBe('closed');
  });

  it('promoteToSubmit() blocks on the per-request advisory lock before it takes a single row lock', async () => {
    const seed = await seedDraftProposalForPromote();
    const actorUserId = await seedActorId();

    const held = await holdOpen(gateDb, (tx) => acquireRequestLock(tx, seed.requestId));

    const promoting = contend(
      runOn(aDb, () =>
        proposalsRepository.promoteToSubmit({
          proposalId: seed.proposalId,
          relationshipId: seed.relationshipId,
          actorUserId,
        })
      )
    );

    await waitUntilBlockedBy(aPid, gatePid, promoting);
    await held.commit();

    const result = await promoting;
    expect(result.status).toBe('submitted');
  });

  it('invite() blocks on the per-request advisory lock before it takes a single row lock', async () => {
    const seed = await seedBareRequest();
    const invitedByUserId = await seedActorId();

    const held = await holdOpen(gateDb, (tx) => acquireRequestLock(tx, seed.requestId));

    const inviting = contend(
      runOn(aDb, () =>
        requestExpertRelationshipsRepository.invite({
          projectRequestId: seed.requestId,
          expertProfileId: seed.expertProfileId,
          invitedByUserId,
        })
      )
    );

    await waitUntilBlockedBy(aPid, gatePid, inviting);
    await held.commit();

    const result = await inviting;
    expect(result?.status).toBe('invited');
  });

  it('resubmit() blocks on the per-request advisory lock before it takes a single row lock', async () => {
    const seed = await seedChangesRequestedProposal();

    const held = await holdOpen(gateDb, (tx) => acquireRequestLock(tx, seed.requestId));

    const resubmitting = contend(
      runOn(aDb, () =>
        proposalsRepository.resubmit({
          relationshipId: seed.relationshipId,
          overview: '<p>Revised.</p>',
          pricingMethod: 'tm',
          priceCents: 0,
          depositCents: 25_000,
          rateCents: 18_000,
          cadence: 'monthly',
          milestones: [],
          installments: [],
        })
      )
    );

    await waitUntilBlockedBy(aPid, gatePid, resubmitting);
    await held.commit();

    const result = await resubmitting;
    expect(result.status).toBe('submitted');
    expect(result.version).toBe(2);
  });

  it('materializeFromKickoff() blocks on the per-request advisory lock before it takes a single row lock', async () => {
    _setDb(wardenDb);
    // ⚠ `relationship` is supplied EXPLICITLY with a PLAIN inviter — `proposalFactory`'s own
    // default (when no relationship is given) falls through to `requestExpertRelationshipFactory`'s
    // default `invitedByUserId`, which is `platformRole: 'admin'`. A committed admin user leaks
    // into `users.integration.test.ts`'s unscoped `findIdsByPlatformRoles` query (see the
    // sibling suite's own documented lesson).
    const inviter = await userFactory();
    const rel = await requestExpertRelationshipFactory({ invitedByUserId: inviter.id });
    const source = await proposalFactory({ relationship: rel, values: { status: 'accepted' } });
    const now = new Date();
    await wardenDb
      .update(schema.projectRequests)
      .set({ status: 'accepted', clientBillingConfirmedAt: now, expertTermsConfirmedAt: now })
      .where(eq(schema.projectRequests.id, source.projectRequestId));
    const admin = await userFactory();
    seededRequestIds.push(source.projectRequestId);
    const seededRequest = await readRequest(source.projectRequestId);
    if (seededRequest === undefined) throw new Error('seeded request vanished');
    const companyId = seededRequest.companyId;

    const held = await holdOpen(gateDb, (tx) => acquireRequestLock(tx, source.projectRequestId));

    const materializing = contend(
      runOn(aDb, () =>
        projectEngagementsRepository.materializeFromKickoff({
          requestId: source.projectRequestId,
          companyId,
          expertProfileId: source.expertProfileId,
          sourceProposalId: source.proposal.id,
          relationshipId: source.relationshipId,
          approvingAdminUserId: admin.id,
          pricingMethod: 'fixed',
          priceCents: 300_000,
          baloFeeBps: 2500,
        })
      )
    );

    await waitUntilBlockedBy(aPid, gatePid, materializing);
    await held.commit();

    const result = await materializing;
    expect(result.request.status).toBe('kickoff_approved');

    // ⚠ CLEANUP THIS TEST OWNS ITSELF: `engagements` / `project_engagements` do NOT cascade from
    // `project_requests` (the origination FKs are `ON DELETE SET NULL`, deliberately — the
    // engagement OUTLIVES its origination proposal). The generic `afterEach` above only reaches
    // the request/relationship/proposal graph, so the engagement row would otherwise leak.
    await wardenDb
      .delete(schema.auditEvents)
      .where(eq(schema.auditEvents.entityId, result.engagement.id))
      .catch(() => undefined);
    await wardenDb
      .delete(schema.engagements)
      .where(eq(schema.engagements.id, result.engagement.id))
      .catch(() => undefined);
  });
});

// ── Group B — both contenders in flight; no 40P01, order-independent outcome ────────────

describe('Group B — concurrent writers on the same request never see 40P01', () => {
  it('concurrent promoteToSubmit × close: neither side sees 40P01, and the committed close leaves no open proposal and no live track', async () => {
    const seed = await seedDraftProposalForPromote();
    const actorUserId = await seedActorId();

    const held = await holdOpen(gateDb, (tx) => acquireRequestLock(tx, seed.requestId));

    const { closing } = await issueCloseBlockedOnGate(aDb, aPid, seed.requestId, actorUserId);

    const { contender: promoting } = await issueContenderBlockedOnGate(bDb, bPid, () =>
      proposalsRepository.promoteToSubmit({
        proposalId: seed.proposalId,
        relationshipId: seed.relationshipId,
        actorUserId,
      })
    );

    await settleRaceAgainstGate(held, closing, promoting);

    const request = await readRequest(seed.requestId);
    expect(request?.status).toBe('closed');

    const relationships = await liveRelationshipsForRequest(seed.requestId);
    expect(relationships.every((r) => r.status === 'declined')).toBe(true);

    expect(await openProposalsForRequest(seed.requestId)).toEqual([]);
  });

  // ⚠⚠ fix round — SPLIT FROM ONE AMBIGUOUS "concurrent invite × close" TEST INTO TWO
  // DETERMINISTIC ONES, EMPIRICALLY, NOT BY ASSUMPTION. The prior single test issued `close`'s
  // blocking call before `invite`'s and then branched on `inviteOutcome.status`, as if the winner
  // were genuinely random. It is not: `issueContenderBlockedOnGate` only returns once
  // `waitUntilBlockedBy` confirms, AT THE DATABASE, that the session is already parked in
  // Postgres's advisory-lock wait queue — so whichever side's blocking call is issued (and
  // confirmed) FIRST is first in that FIFO queue and reliably wins the race once the gate
  // releases. Measured directly: swapping the issuance order 10/10 times flips the winner
  // 10/10 times (never once split) — this is deterministic-by-construction, not a coin flip.
  // Consequently the OLD single test's fixed order (close first) could ONLY ever reach the
  // close-won branch — `seedBareRequest()` seeds no relationship, so its
  // `relationships.every(…)` ran on an empty array on every real run, which is exactly the
  // vacuous-assertion defect this fix round exists to close. The two tests below issue each
  // side first in turn, so each branch is exercised for real, every run, and each gets its own
  // non-vacuous row-count assertion (mirroring Group C's `toHaveLength(2)` discipline) rather
  // than a `.every()` that would pass trivially on an empty array either way.
  it('concurrent invite × close, close wins the gate: invite is refused under the lock, before any row is inserted', async () => {
    const seed = await seedBareRequest();
    const actorUserId = await seedActorId();

    const held = await holdOpen(gateDb, (tx) => acquireRequestLock(tx, seed.requestId));

    // close's blocking call is issued (and confirmed blocked) FIRST — see the fix-round note
    // above for why that deterministically makes close win the gate once it is released.
    const { closing } = await issueCloseBlockedOnGate(aDb, aPid, seed.requestId, actorUserId);

    const { contender: inviting } = await issueContenderBlockedOnGate(bDb, bPid, () =>
      requestExpertRelationshipsRepository.invite({
        projectRequestId: seed.requestId,
        expertProfileId: seed.expertProfileId,
        invitedByUserId: actorUserId,
      })
    );

    const { contenderOutcome: inviteOutcome } = await settleRaceAgainstGate(
      held,
      closing,
      inviting
    );

    expect(inviteOutcome.status).toBe('rejected');
    if (inviteOutcome.status === 'rejected') {
      expect(inviteOutcome.reason).toBeInstanceOf(RequestClosedError);
    }

    // MUTATION TARGET (this branch): remove `invite`'s `if (request?.status === 'closed') throw
    // new RequestClosedError(…)` guard in `request-expert-relationships.ts` and this goes RED —
    // a relationship would be inserted despite the request already being closed.
    const relationships = await liveRelationshipsForRequest(seed.requestId);
    expect(relationships).toHaveLength(0);
  });

  it('concurrent invite × close, invite wins the gate: its relationship is created, then declined by close’s cascade', async () => {
    const seed = await seedBareRequest();
    const actorUserId = await seedActorId();

    const held = await holdOpen(gateDb, (tx) => acquireRequestLock(tx, seed.requestId));

    // invite's blocking call is issued (and confirmed blocked) FIRST this time — the mirror
    // image of the sibling test above, so invite reliably wins the gate instead of close.
    const { contender: inviting } = await issueContenderBlockedOnGate(bDb, bPid, () =>
      requestExpertRelationshipsRepository.invite({
        projectRequestId: seed.requestId,
        expertProfileId: seed.expertProfileId,
        invitedByUserId: actorUserId,
      })
    );

    const { closing } = await issueCloseBlockedOnGate(aDb, aPid, seed.requestId, actorUserId);

    const { contenderOutcome: inviteOutcome } = await settleRaceAgainstGate(
      held,
      closing,
      inviting
    );

    expect(inviteOutcome.status).toBe('fulfilled');

    // MUTATION TARGET (this branch): confirmed RED when `invite`'s insert is forced to a no-op
    // (see the fix-round report) — `toHaveLength(1)` catches the empty-array shape that a bare
    // `.every()` would have passed vacuously.
    const relationships = await liveRelationshipsForRequest(seed.requestId);
    expect(relationships).toHaveLength(1);
    expect(relationships.every((r) => r.status === 'declined')).toBe(true);
  });

  it('concurrent submit × close: no open proposal survives a committed close', async () => {
    const seed = await seedRelationship('proposal_requested');
    const actorUserId = await seedActorId();

    const held = await holdOpen(gateDb, (tx) => acquireRequestLock(tx, seed.requestId));

    const { closing } = await issueCloseBlockedOnGate(aDb, aPid, seed.requestId, actorUserId);

    const { contender: submitting } = await issueContenderBlockedOnGate(bDb, bPid, () =>
      proposalsRepository.submit({
        relationshipId: seed.relationshipId,
        actorUserId,
        overview: '<p>Race fixture.</p>',
        pricingMethod: 'tm',
        priceCents: 0,
        depositCents: 25_000,
        rateCents: 18_000,
        cadence: 'monthly',
      })
    );

    await settleRaceAgainstGate(held, closing, submitting);

    expect(await openProposalsForRequest(seed.requestId)).toEqual([]);
  });

  it('concurrent resubmit × close: no open proposal survives a committed close', async () => {
    const seed = await seedChangesRequestedProposal();
    const actorUserId = await seedActorId();

    const held = await holdOpen(gateDb, (tx) => acquireRequestLock(tx, seed.requestId));

    const { closing } = await issueCloseBlockedOnGate(aDb, aPid, seed.requestId, actorUserId);

    const { contender: resubmitting } = await issueContenderBlockedOnGate(bDb, bPid, () =>
      proposalsRepository.resubmit({
        relationshipId: seed.relationshipId,
        overview: '<p>Revised.</p>',
        pricingMethod: 'tm',
        priceCents: 0,
        depositCents: 25_000,
        rateCents: 18_000,
        cadence: 'monthly',
        milestones: [],
        installments: [],
      })
    );

    await settleRaceAgainstGate(held, closing, resubmitting);

    expect(await openProposalsForRequest(seed.requestId)).toEqual([]);
  });
});

// ── Group C — the union re-read, proved against a writer that does NOT take the lock ────

describe('Group C — the union re-read catches a row committed after the pre-lock snapshot', () => {
  it('a relationship committed while close() is stalled on its step-2 snapshot is still declined — the union re-read, not the snapshot', async () => {
    const seed = await seedRelationship('invited');
    const actorUserId = await seedActorId();

    const held = await holdOpen(gateDb, (tx) =>
      tx
        .select()
        .from(schema.requestExpertRelationships)
        .where(eq(schema.requestExpertRelationships.id, seed.relationshipId))
        .for('update')
    );

    const { closing } = await issueCloseBlockedOnGate(aDb, aPid, seed.requestId, actorUserId);

    _setDb(wardenDb);
    const expert2 = await expertDraftFactory();
    const r2Id = await insertCommittedRelationship({
      projectRequestId: seed.requestId,
      expertProfileId: expert2.id,
      invitedByUserId: actorUserId,
      status: 'invited',
    });

    await held.commit();

    const result = await closing;
    expect(
      result.declinedTracks
        .map((t) => t.relationshipId)
        .slice()
        .sort()
    ).toEqual([seed.relationshipId, r2Id].slice().sort());

    const r1 = await readRelationship(seed.relationshipId);
    const r2 = await readRelationship(r2Id);
    expect(r1?.status).toBe('declined');
    expect(r2?.status).toBe('declined');
  });

  it('a proposal committed while close() is stalled on its step-1 snapshot is still withdrawn — the union re-read, not the snapshot', async () => {
    const { result, proposalIds } = await raceProposalCommitAgainstCloseSnapshot();

    expect(result.withdrawnProposalIds.slice().sort()).toEqual(proposalIds.slice().sort());

    const [p1, p2] = await Promise.all(proposalIds.map((id) => readProposal(id)));
    expect(p1?.status).toBe('withdrawn');
    expect(p2?.status).toBe('withdrawn');
  });

  it('the union never advances the same proposal twice', async () => {
    // Concatenation instead of dedupe would advance the overlapping proposal a SECOND time,
    // which throws InvalidProposalTransitionError and rolls the whole close back — so `closing`
    // rejecting inside the helper below IS this test's red signal, not a separate assertion.
    const { result, proposalIds } = await raceProposalCommitAgainstCloseSnapshot();
    const ids = result.withdrawnProposalIds;
    // ⚠ COMPLETENESS, NOT JUST UNIQUENESS. A missing re-read (no duplicate to find) would
    // satisfy a bare uniqueness check VACUOUSLY — `ids.length` would just be 1. Pinning the
    // exact length forces BOTH proposals to be present, so this case is red under either
    // mutation: a dropped re-read (too few ids) or a concatenated union (too many, and a
    // rejection before this line is ever reached).
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice().sort()).toEqual(proposalIds.slice().sort());
  });

  it('a proposal committed while declineTrack() is stalled on its snapshot is still declined', async () => {
    const seed = await seedRelationship('proposal_submitted');
    const p1Id = await insertCommittedProposal({
      relationshipId: seed.relationshipId,
      projectRequestId: seed.requestId,
      expertProfileId: seed.expertProfileId,
      status: 'draft',
      isCurrent: true,
    });
    const actorUserId = await seedActorId();

    const held = await holdOpen(gateDb, (tx) =>
      tx.select().from(schema.proposals).where(eq(schema.proposals.id, p1Id)).for('update')
    );

    const declining = contend(
      runOn(aDb, () =>
        requestExpertRelationshipsRepository.declineTrack({
          relationshipId: seed.relationshipId,
          actorUserId,
          reason: 'client_declined',
        })
      )
    );
    await waitUntilBlockedBy(aPid, gatePid, declining);

    // The SAME relationship's SECOND open proposal — `isCurrent: false`, since P1 already holds
    // the partial-unique `is_current` slot for this relationship.
    const p2Id = await insertCommittedProposal({
      relationshipId: seed.relationshipId,
      projectRequestId: seed.requestId,
      expertProfileId: seed.expertProfileId,
      status: 'submitted',
      isCurrent: false,
    });

    await held.commit();

    const result = await declining;
    expect(result.declinedProposalIds.slice().sort()).toEqual([p1Id, p2Id].slice().sort());

    const persistedP1 = await readProposal(p1Id);
    const persistedP2 = await readProposal(p2Id);
    expect(persistedP1?.status).toBe('declined');
    expect(persistedP2?.status).toBe('declined');
  });
});
