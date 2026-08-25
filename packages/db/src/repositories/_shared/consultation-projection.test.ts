import { describe, it, expect } from 'vitest';
import { engagements, requestExpertRelationships } from '../../schema';
import type { MeetingContextType } from '../../schema';
import {
  MeetingContextNotProjectableError,
  MeetingContextUnresolvableError,
  MeetingExpertAmbiguousError,
  resolveMeetingExpertTx,
  type ProjectionContext,
} from './consultation-projection';
import type { DbExecutor } from './db-executor';

/**
 * BAL-283 (Ruling 1) — the `request_interaction` arm of the consultation projection, as a
 * UNIT test.
 *
 * ⚠⚠ THIS FILE IS THE EXPLICIT HALF-ADD ASSERTION, AND NOTHING ELSE PROVIDES IT.
 * `invariants/meeting-context-type-labels.test.ts` — the test the ticket names as the safety
 * net — imports `meetingContextTypeEnum` and asserts on `enumValues` only. IT NEVER OPENS
 * THIS MODULE. The arm has to be added to BOTH `loadContextExperts` and `resolveOneContext`,
 * and before BAL-283 the two were only ASYMMETRICALLY coupled: an arm in `resolveOneContext`
 * alone (a constant return, consulting no map) left `loadContextExperts` merely wasting
 * nothing, and every test passed. A half-add then shipped silently and failed in production
 * on the first row written.
 *
 * BAL-283 removes that asymmetry STRUCTURALLY — the new `resolveOneContext` arm answers from
 * `maps.relationshipExperts`, which only `loadContextExperts` can populate — and these tests
 * pin both directions:
 *
 *   arm in `resolveOneContext` only  → empty map → `MeetingContextUnresolvableError`  (T1)
 *   arm in `loadContextExperts` only → switch `default` → `MeetingContextNotProjectableError`
 *                                      (and a `pnpm --filter api typecheck` error first)   (T1)
 *   arm queued into the WRONG batch  → an `engagements` query, no relationships query   (T2)
 *
 * The rest of the projection's behaviour needs a real Postgres and lives in
 * `consultation-projection.integration.test.ts`, which carries the same proof against real
 * SQL (§13.2 of the BAL-283 plan).
 *
 * ⚠ THE PRE-BAL-283 SUITE THAT LIVED HERE IS GONE ON PURPOSE. Its five tests asserted that
 * this label THREW `MeetingContextNotProjectableError` and that the message named BAL-283 as
 * the owner of an unmade ruling. The ruling is made: a client↔candidate call DOES block the
 * candidate's calendar. Those assertions are now the exact opposite of the contract.
 */

// ── Fixtures ───────────────────────────────────────────────────────────

const RELATIONSHIP_EXPERT_ID = '99999999-9999-4999-8999-999999999999';
const ENGAGEMENT_EXPERT_ID = '88888888-8888-4888-8888-888888888888';

const CASE_CONTEXT: ProjectionContext = {
  contextType: 'case',
  contextId: '11111111-1111-4111-8111-111111111111',
};
const INTERACTION_CONTEXT: ProjectionContext = {
  contextType: 'request_interaction',
  contextId: '22222222-2222-4222-8222-222222222222',
};
const ADMIN_CONTEXT: ProjectionContext = { contextType: 'admin', contextId: null };

/**
 * A LABEL THAT DOES NOT EXIST, cast past the type — the shape a raw DB row could take if a
 * future migration added an 8th `meeting_context_type` value and this module was not swept.
 * Keeps the retained `MeetingContextNotProjectableError` class reachable and covered.
 */
const FUTURE_CONTEXT: ProjectionContext = {
  contextType: 'future_label' as MeetingContextType,
  contextId: '33333333-3333-4333-8333-333333333333',
};

// ── Stub executors ─────────────────────────────────────────────────────

/** An executor that must never be used. Any property access is a test failure. */
const UNUSED_EXECUTOR = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `resolveMeetingExpertTx touched the database (accessed '${String(property)}') — this context set must resolve with ZERO queries`
      );
    },
  }
) as unknown as DbExecutor;

interface RecordingExecutor {
  exec: DbExecutor;
  /** The table object handed to each `.from()`, in call order. */
  tablesQueried: () => readonly unknown[];
}

/**
 * An executor that RECORDS THE TABLE each batched lookup targets and answers from `rows`.
 *
 * Recording the table object (not a query count) is what makes T2 a real assertion: it fails
 * both when the arm is missing entirely (no relationships query at all) AND when the id was
 * queued into the WRONG id set (an `engagements` query for a relationship id — the
 * pre-BAL-413 defect, which resolved to nothing and threw a misleading "unresolvable").
 */
function recordingExecutor(rows: Map<unknown, readonly unknown[]>): RecordingExecutor {
  const tables: unknown[] = [];
  const exec = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          tables.push(table);
          return Promise.resolve(rows.get(table) ?? []);
        },
      }),
    }),
  } as unknown as DbExecutor;
  return { exec, tablesQueried: () => tables };
}

/** The one live relationship row the fixtures above describe. */
function liveRelationshipRows(
  expertProfileId = RELATIONSHIP_EXPERT_ID
): Map<unknown, readonly unknown[]> {
  return new Map<unknown, readonly unknown[]>([
    [requestExpertRelationships, [{ id: INTERACTION_CONTEXT.contextId, expertProfileId }]],
  ]);
}

describe('resolveMeetingExpertTx — the request_interaction arm (BAL-283, Ruling 1)', () => {
  it('T1 — resolves to the RELATIONSHIP row’s expert (fails on EITHER half-add)', async () => {
    // ⚠ THE LOAD-BEARING TEST. Missing `loadContextExperts` arm ⇒ `relationshipExperts` is
    // empty ⇒ `MeetingContextUnresolvableError`. Missing `resolveOneContext` arm ⇒ the
    // switch `default` ⇒ `MeetingContextNotProjectableError`. Only both-arms-present
    // resolves.
    const { exec } = recordingExecutor(liveRelationshipRows());

    await expect(resolveMeetingExpertTx(exec, [INTERACTION_CONTEXT], 'meeting_1')).resolves.toBe(
      RELATIONSHIP_EXPERT_ID
    );
  });

  it('T2 — reads `request_expert_relationships`, and NEVER `engagements`', async () => {
    // Pins WHICH id set `loadContextExperts` queued the context into. A `request_interaction`
    // `context_id` is a `request_expert_relationships.id`; looking it up in `engagements` is
    // a guaranteed miss that the resolver would then have to misdiagnose.
    const { exec, tablesQueried } = recordingExecutor(liveRelationshipRows());

    await resolveMeetingExpertTx(exec, [INTERACTION_CONTEXT], 'meeting_1');

    expect(tablesQueried()).toContain(requestExpertRelationships);
    expect(tablesQueried()).not.toContain(engagements);
    // Exactly one batch — the relationship one. Zero would mean no arm at all.
    expect(tablesQueried()).toHaveLength(1);
  });

  it('T3 — no live relationship row is UNRESOLVABLE, not "no projection rule"', async () => {
    // The post-BAL-283 diagnosis. A soft-deleted (withdrawn) or missing relationship is an id
    // that resolves to nothing — which is exactly what `MeetingContextUnresolvableError`
    // says. `MeetingContextNotProjectableError` would now be a lie: the rule exists.
    const { exec } = recordingExecutor(new Map());

    const promise = resolveMeetingExpertTx(exec, [INTERACTION_CONTEXT], 'meeting_1');
    await expect(promise).rejects.toBeInstanceOf(MeetingContextUnresolvableError);
    await expect(
      resolveMeetingExpertTx(exec, [INTERACTION_CONTEXT], 'meeting_1')
    ).rejects.not.toBeInstanceOf(MeetingContextNotProjectableError);
  });

  it('T4a — mixed with a case context naming the SAME expert: resolves, TWO batched queries', async () => {
    // Batching, pinned: one query per TARGET TABLE for the whole set, never one per context.
    const rows = new Map<unknown, readonly unknown[]>([
      [
        requestExpertRelationships,
        [{ id: INTERACTION_CONTEXT.contextId, expertProfileId: RELATIONSHIP_EXPERT_ID }],
      ],
      [engagements, [{ id: CASE_CONTEXT.contextId, expertProfileId: RELATIONSHIP_EXPERT_ID }]],
    ]);
    const { exec, tablesQueried } = recordingExecutor(rows);

    await expect(
      resolveMeetingExpertTx(exec, [INTERACTION_CONTEXT, CASE_CONTEXT], 'meeting_1')
    ).resolves.toBe(RELATIONSHIP_EXPERT_ID);
    expect(tablesQueried()).toHaveLength(2);
  });

  it('T4b — mixed naming DIFFERENT experts is AMBIGUOUS (the label participates in the check)', async () => {
    // A `request_interaction` context is a full participant in ambiguity detection, not a
    // special case that is skipped — a meeting whose contexts name two calendars has no
    // answer to "whose slot does this block?".
    const rows = new Map<unknown, readonly unknown[]>([
      [
        requestExpertRelationships,
        [{ id: INTERACTION_CONTEXT.contextId, expertProfileId: RELATIONSHIP_EXPERT_ID }],
      ],
      [engagements, [{ id: CASE_CONTEXT.contextId, expertProfileId: ENGAGEMENT_EXPERT_ID }]],
    ]);
    const { exec } = recordingExecutor(rows);

    await expect(
      resolveMeetingExpertTx(exec, [INTERACTION_CONTEXT, CASE_CONTEXT], 'meeting_1')
    ).rejects.toBeInstanceOf(MeetingExpertAmbiguousError);
  });

  it('T5 — an 8th, unswept label still fails CLOSED with the retained named error', async () => {
    // `MeetingContextNotProjectableError` is KEPT, not deleted: it stops being
    // `request_interaction`'s error and becomes the generic defence. The `never` witness in
    // the switch `default` catches this at typecheck for a real enum label; this proves the
    // RUNTIME half, for a label arriving from a raw row that a cast let past the type.
    const { exec } = recordingExecutor(new Map());

    await expect(
      resolveMeetingExpertTx(exec, [FUTURE_CONTEXT], 'meeting_1')
    ).rejects.toBeInstanceOf(MeetingContextNotProjectableError);
    // The message must tell the next builder WHAT to do — and must no longer name BAL-283 as
    // a pending owner, because that ruling is made and shipped.
    await expect(resolveMeetingExpertTx(exec, [FUTURE_CONTEXT], 'meeting_1')).rejects.toThrow(
      /loadContextExperts and resolveOneContext/
    );
    await expect(resolveMeetingExpertTx(exec, [FUTURE_CONTEXT], 'meeting_1')).rejects.not.toThrow(
      /BAL-283/
    );
  });

  it('T6 — an admin-only context set still resolves to null with ZERO queries (guards the guard)', async () => {
    // Without this, T1–T5 would also pass if the stub executor were simply broken.
    await expect(
      resolveMeetingExpertTx(UNUSED_EXECUTOR, [ADMIN_CONTEXT], 'meeting_1')
    ).resolves.toBeNull();
    await expect(resolveMeetingExpertTx(UNUSED_EXECUTOR, [], 'meeting_1')).resolves.toBeNull();
  });
});
