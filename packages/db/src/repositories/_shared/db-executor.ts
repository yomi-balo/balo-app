import type { db, Database } from '../../client';

/**
 * Either the base Drizzle client OR an in-flight transaction handle. Lets a
 * repository function compose under a parent `db.transaction` (executor supplied)
 * or self-wrap when called standalone (defaults to the base `db`).
 *
 * Extracted here so multiple repositories share ONE definition rather than each
 * re-deriving it. Mirrors the inline `DbExecutor` in `experts.ts` and the `DbTx`
 * in `proposal-milestones.ts` (those keep their local copies — out of scope to
 * refactor); new code imports this shared type.
 */
export type DbExecutor = Database | Parameters<Parameters<typeof db.transaction>[0]>[0];
