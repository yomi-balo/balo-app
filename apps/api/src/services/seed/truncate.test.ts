import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  users,
  expertProfiles,
  companies,
  conversations,
  conversationMessages,
  conversationFiles,
} from '@balo/db';
import { truncateSeedData } from './truncate.js';

/**
 * BAL-424 — THE ORDERING GUARD FOR `deleteSeedConversations`.
 *
 * The re-anchor removed the cascade that used to clear the messaging subtree when the seed
 * company went (`conversation_messages` → `request_expert_relationships` → `project_requests`
 * → `companies`). `conversation_contexts.context_id` has NO FK by design, so nothing replaces
 * it — and because `sender_user_id` / `uploaded_by_user_id` are `ON DELETE RESTRICT`, the
 * `users` delete now raises `23503` unless the conversations go FIRST.
 *
 * ⚠ THE ORDERING IS THE ENTIRE FIX, AND IT IS INVISIBLE TO EVERY OTHER GATE. Reordering
 * `truncateSeedData` compiles, lints and typechecks; the integration harness never exercises
 * the seeder; and the failure only appears against a database that has actually been seeded
 * and written to. So it is pinned HERE, against a recording stub, rather than left to review.
 *
 * The stub records only what these assertions need — the sequence of `delete(table)` calls and
 * the tables each `select` reads. It deliberately does NOT emulate Drizzle: this is a test of
 * ORDER, not of SQL.
 */

type TableRef = object;

interface Recorder {
  /** `delete(table)` calls, in order. */
  readonly deletes: TableRef[];
  /** `select(...).from(table)` reads, in order. */
  readonly reads: TableRef[];
  /** Rows each table's `select` should resolve to, keyed by table. */
  readonly rows: Map<TableRef, unknown[]>;
}

/**
 * A thenable that also answers the fluent chain, so `.from(t).where(c)` and
 * `.from(t)` both await correctly regardless of where the caller stops chaining.
 */
function chain(recorder: Recorder, kind: 'read' | 'delete'): Record<string, unknown> {
  let table: TableRef | null = null;
  const node: Record<string, unknown> = {
    from(t: TableRef) {
      table = t;
      if (kind === 'read') recorder.reads.push(t);
      return node;
    },
    where() {
      return node;
    },
    innerJoin() {
      return node;
    },
    groupBy() {
      return node;
    },
    limit() {
      return node;
    },
    orderBy() {
      return node;
    },
    returning() {
      return node;
    },
    then(resolve: (value: unknown[]) => unknown) {
      const value = table === null ? [] : (recorder.rows.get(table) ?? []);
      return Promise.resolve(value).then(resolve);
    },
  };
  return node;
}

function makeTx(recorder: Recorder): Parameters<typeof truncateSeedData>[0] {
  const tx = {
    select: () => chain(recorder, 'read'),
    selectDistinct: () => chain(recorder, 'read'),
    delete: (table: TableRef) => {
      recorder.deletes.push(table);
      return chain(recorder, 'delete');
    },
  };
  return tx as unknown as Parameters<typeof truncateSeedData>[0];
}

function newRecorder(rows: Array<[TableRef, unknown[]]> = []): Recorder {
  return { deletes: [], reads: [], rows: new Map(rows) };
}

const SEED_USER = { id: 'user-seed-1' };
const SEED_PROFILE = { id: 'profile-seed-1' };
const SEED_CONVERSATION = { conversationId: 'conv-seed-1' };

let previousNodeEnv: string | undefined;

beforeEach(() => {
  previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  process.env.NODE_ENV = previousNodeEnv;
});

describe('truncateSeedData — BAL-424 conversation sweep ordering', () => {
  /**
   * ⚠⚠ THE LOAD-BEARING ASSERTION. `conversations` MUST be deleted before `users`, or the
   * RESTRICT on message/file authorship raises `23503` and the whole seed transaction rolls
   * back. Asserting the INDICES (not merely "both were called") is what makes a reordering
   * fail this test.
   */
  it('deletes conversations BEFORE users', async () => {
    const recorder = newRecorder([
      [users, [SEED_USER]],
      [expertProfiles, [SEED_PROFILE]],
      [conversationMessages, [SEED_CONVERSATION]],
      [conversationFiles, []],
    ]);

    await truncateSeedData(makeTx(recorder), 'experts');

    const conversationsAt = recorder.deletes.indexOf(conversations);
    const usersAt = recorder.deletes.indexOf(users);
    expect(conversationsAt).toBeGreaterThanOrEqual(0);
    expect(usersAt).toBeGreaterThanOrEqual(0);
    expect(conversationsAt).toBeLessThan(usersAt);
  });

  /** …and before the seed COMPANY, whose cascade removes the relationship graph. */
  it('deletes conversations before the seed company', async () => {
    const recorder = newRecorder([
      [users, [SEED_USER]],
      [conversationMessages, [SEED_CONVERSATION]],
      [conversationFiles, []],
    ]);

    await truncateSeedData(makeTx(recorder), 'experts');

    expect(recorder.deletes.indexOf(conversations)).toBeLessThan(
      recorder.deletes.indexOf(companies)
    );
  });

  /**
   * KEYED ON AUTHORSHIP, NOT ON THE ANCHOR — the anchor may already have been cascaded away
   * by the `companies` delete, leaving a conversation pointing at nothing. Authorship is the
   * edge that actually blocks the `users` delete.
   */
  it('finds conversations through BOTH authorship legs', async () => {
    const recorder = newRecorder([
      [users, [SEED_USER]],
      [conversationMessages, [SEED_CONVERSATION]],
      [conversationFiles, [{ conversationId: 'conv-seed-2' }]],
    ]);

    await truncateSeedData(makeTx(recorder), 'experts');

    expect(recorder.reads).toContain(conversationMessages);
    expect(recorder.reads).toContain(conversationFiles);
    expect(recorder.deletes).toContain(conversations);
  });

  it('deletes no conversation when authorship finds none', async () => {
    const recorder = newRecorder([
      [users, [SEED_USER]],
      [conversationMessages, []],
      [conversationFiles, []],
    ]);

    await truncateSeedData(makeTx(recorder), 'experts');

    // Both legs are still CONSULTED — the sweep must ask before concluding there is nothing.
    expect(recorder.reads).toContain(conversationMessages);
    expect(recorder.deletes).not.toContain(conversations);
  });

  it('skips the sweep entirely when there are no seed users', async () => {
    const recorder = newRecorder([
      [users, []],
      [expertProfiles, []],
    ]);

    await truncateSeedData(makeTx(recorder), 'experts');

    expect(recorder.reads).not.toContain(conversationMessages);
    expect(recorder.reads).not.toContain(conversationFiles);
    expect(recorder.deletes).not.toContain(conversations);
  });

  /**
   * The `availability` scope returns before the expert/user teardown, so it must not touch
   * conversations at all — that scope exists to clear booking state, not identity.
   */
  it('does not sweep conversations in the availability scope', async () => {
    const recorder = newRecorder([
      [users, [SEED_USER]],
      [expertProfiles, [SEED_PROFILE]],
      [conversationMessages, [SEED_CONVERSATION]],
    ]);

    await truncateSeedData(makeTx(recorder), 'availability');

    expect(recorder.deletes).not.toContain(conversations);
    expect(recorder.deletes).not.toContain(users);
  });
});

describe('truncateSeedData — the NODE_ENV allowlist still guards the sweep', () => {
  it.each([undefined, 'production', 'staging'])('refuses under NODE_ENV=%s', async (nodeEnv) => {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;

    const recorder = newRecorder();
    await expect(truncateSeedData(makeTx(recorder), 'experts')).rejects.toThrow(
      /truncateSeedData refused/
    );
    // Nothing at all ran — including the new conversation sweep.
    expect(recorder.deletes).toEqual([]);
    expect(recorder.reads).toEqual([]);
  });
});
