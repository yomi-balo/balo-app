import { describe, it, expect } from 'vitest';
import {
  MeetingContextNotProjectableError,
  resolveMeetingExpertTx,
  type ProjectionContext,
} from './consultation-projection';
import type { DbExecutor } from './db-executor';

/**
 * BAL-413 — the `request_interaction` arm of the consultation projection, as a UNIT test.
 *
 * ⚠ WHY THIS IS UNIT-TESTABLE AT ALL, AND WHY THAT IS THE POINT. The whole behaviour under
 * test is that this label reaches NO TABLE: `loadContextExperts` queues its `context_id`
 * into neither id set, and `resolveOneContext` answers without consulting a lookup map. So
 * the executor below is a Proxy that THROWS on any property access — if the resolver ever
 * starts issuing a query for this label (the pre-BAL-413 behaviour, where the id fell into
 * the engagement `else` and was looked up in the WRONG table), these tests fail with
 * "touched the database" rather than quietly passing.
 *
 * The rest of the projection's behaviour needs a real Postgres and lives in
 * `consultation-projection.integration.test.ts`.
 */

// ── Fixtures ───────────────────────────────────────────────────────────

const EXPERT_PROFILE_ID = '99999999-9999-4999-8999-999999999999';

const CASE_CONTEXT: ProjectionContext = {
  contextType: 'case',
  contextId: '11111111-1111-4111-8111-111111111111',
};
const INTERACTION_CONTEXT: ProjectionContext = {
  contextType: 'request_interaction',
  contextId: '22222222-2222-4222-8222-222222222222',
};
const ADMIN_CONTEXT: ProjectionContext = { contextType: 'admin', contextId: null };

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

/**
 * An executor that answers the batched lookup with the ONE live engagement row below, and
 * counts the queries it was asked for.
 *
 * Needed only for the MIXED case. `loadContextExperts` batches deliberately (one query per
 * target table for the WHOLE context set) and therefore runs before the fail-fast walk in
 * `resolveExpert`, so a `case` context in the set means the engagements batch legitimately
 * fires and the zero-query executor cannot be used. Returning the row rather than `[]`
 * matters: with no rows the `case` context would itself resolve `unresolvable` and
 * fail-fast FIRST, and the test would pass for the wrong reason.
 */
function countingExecutor(): { exec: DbExecutor; queries: () => number } {
  let count = 0;
  const exec = {
    select: () => ({
      from: () => ({
        where: () => {
          count += 1;
          return Promise.resolve([
            { id: CASE_CONTEXT.contextId, expertProfileId: EXPERT_PROFILE_ID },
          ]);
        },
      }),
    }),
  } as unknown as DbExecutor;
  return { exec, queries: () => count };
}

describe('resolveMeetingExpertTx — the request_interaction arm (BAL-413)', () => {
  it('throws MeetingContextNotProjectableError, not MeetingContextUnresolvableError', async () => {
    // The pre-fix behaviour threw `MeetingContextUnresolvableError` — an accurate-sounding
    // but WRONG diagnosis ("does not resolve to a live row") about a row that exists and is
    // perfectly live. The distinction is the entire fix: a named decision, not a
    // fall-through into the engagement lookup.
    await expect(
      resolveMeetingExpertTx(UNUSED_EXECUTOR, [INTERACTION_CONTEXT], 'meeting_1')
    ).rejects.toBeInstanceOf(MeetingContextNotProjectableError);
  });

  it('names the label, the id and the ticket that owns the missing rule', async () => {
    // A builder hitting this in a booking-lane surface must learn WHAT to do from the
    // message alone — this is a deliberately-unfinished seam, not a bug report.
    await expect(
      resolveMeetingExpertTx(UNUSED_EXECUTOR, [INTERACTION_CONTEXT], 'meeting_1')
    ).rejects.toThrow(/request_interaction/);
    await expect(
      resolveMeetingExpertTx(UNUSED_EXECUTOR, [INTERACTION_CONTEXT], 'meeting_1')
    ).rejects.toThrow(/BAL-283/);
  });

  it.each([
    ['first in the set', [INTERACTION_CONTEXT, CASE_CONTEXT]],
    ['last in the set', [CASE_CONTEXT, INTERACTION_CONTEXT]],
  ])(
    'rejects the WHOLE context set when a request_interaction context appears %s',
    async (_label, contexts) => {
      // Position must not matter: a meeting that names an unprojectable context is not
      // projectable, whatever else it names. (`meeting_context_unique_idx` allows a meeting
      // to carry several context rows, so mixed sets are a real shape, not a hypothetical.)
      const { exec, queries } = countingExecutor();
      await expect(resolveMeetingExpertTx(exec, contexts, 'meeting_1')).rejects.toBeInstanceOf(
        MeetingContextNotProjectableError
      );
      // ONE query — the engagements batch the `case` context legitimately needs. The
      // `request_interaction` id was queued into NO id set, so it added no second query
      // (and, before the fix, would have been queued into the engagements batch itself).
      expect(queries()).toBe(1);
    }
  );

  it('is NOT silently ignored — the outcome that would double-book a calendar', async () => {
    // The tempting third option. Treating it as `ignored` alongside `admin` would let a
    // meeting be written with NO projection row, i.e. a booking blocking nobody — exactly
    // the drift BAL-428 exists to close. Pinned so a future "simplification" has to argue.
    await expect(
      resolveMeetingExpertTx(UNUSED_EXECUTOR, [INTERACTION_CONTEXT], 'meeting_1')
    ).rejects.toThrow();
  });

  it('still resolves an admin-only context set to null with zero queries (guards the guard)', async () => {
    // Without this, every assertion above would also pass if the Proxy were simply broken
    // or if `resolveMeetingExpertTx` threw unconditionally.
    await expect(
      resolveMeetingExpertTx(UNUSED_EXECUTOR, [ADMIN_CONTEXT], 'meeting_1')
    ).resolves.toBeNull();
    await expect(resolveMeetingExpertTx(UNUSED_EXECUTOR, [], 'meeting_1')).resolves.toBeNull();
  });
});
