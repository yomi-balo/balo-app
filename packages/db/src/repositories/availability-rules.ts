import { and, asc, eq, isNull } from 'drizzle-orm';
import { type Database, db } from '../client';
import { availabilityRules, type AvailabilityRule } from '../schema';

/**
 * Either the base Drizzle client or an in-flight transaction handle. Lets a
 * mutation compose under a parent `db.transaction` (executor supplied) — so the
 * schedule POST handler can run `replaceForExpert` in the SAME tx as
 * `expertsRepository.updateProfile` — while still self-wrapping when called
 * standalone (executor omitted → defaults to `db`). Mirrors the `DbExecutor`
 * precedent in `experts.ts`.
 */
type DbExecutor = Database | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * One weekly recurring window as written by the schedule editor. Times are
 * wall-clock 'HH:mm' in the expert's timezone; Postgres `time` stores them as
 * 'HH:mm:ss' (the read/UI layer trims the seconds back off).
 */
export interface WeeklyRuleInput {
  dayOfWeek: number;
  startTime: string; // 'HH:mm'
  endTime: string; // 'HH:mm'
}

/**
 * Soft-delete every active rule for the expert, then bulk-insert the incoming
 * set as fresh rows. Runs inline on the passed executor (a parent `tx` or a
 * self-opened `tx`), so replace is one atomic unit. The table has NO unique
 * constraint on (expert, day, start), so delete-then-insert never trips a
 * soft-delete/unique re-create hazard.
 */
async function replaceForExpertTx(
  exec: DbExecutor,
  expertProfileId: string,
  rules: WeeklyRuleInput[]
): Promise<void> {
  await exec
    .update(availabilityRules)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(availabilityRules.expertProfileId, expertProfileId),
        isNull(availabilityRules.deletedAt)
      )
    );

  if (rules.length > 0) {
    await exec.insert(availabilityRules).values(
      rules.map((r) => ({
        expertProfileId,
        dayOfWeek: r.dayOfWeek,
        startTime: r.startTime,
        endTime: r.endTime,
      }))
    );
  }
}

/**
 * Repository for `availability_rules` (BAL-243 read + BAL-234 schedule-editor
 * mutations). All mutations honor the table's soft-delete design.
 */
export const availabilityRulesRepository = {
  /**
   * All non-deleted weekly recurring rules for an expert, ordered by dayOfWeek
   * then startTime so the resolver can expand them deterministically.
   */
  async listByExpertProfileId(expertProfileId: string): Promise<AvailabilityRule[]> {
    return db.query.availabilityRules.findMany({
      where: and(
        eq(availabilityRules.expertProfileId, expertProfileId),
        isNull(availabilityRules.deletedAt)
      ),
      orderBy: [asc(availabilityRules.dayOfWeek), asc(availabilityRules.startTime)],
    });
  },

  /**
   * Upsert-replace (soft-delete) the full weekly schedule for an expert: in one
   * transaction, soft-delete every currently-active rule then bulk-insert the
   * incoming set. Deterministic and idempotent — re-saving the same set leaves
   * exactly N active rows (no duplicates) while preserving audit history.
   * Executor-aware so the POST handler can run it inside the same tx as
   * `expertsRepository.updateProfile`.
   */
  async replaceForExpert(
    expertProfileId: string,
    rules: WeeklyRuleInput[],
    executor?: DbExecutor
  ): Promise<void> {
    if (executor) {
      await replaceForExpertTx(executor, expertProfileId, rules);
      return;
    }
    await db.transaction((tx) => replaceForExpertTx(tx, expertProfileId, rules));
  },

  /**
   * Soft-delete every active rule for the expert ("clear schedule" / DELETE
   * endpoint). A single UPDATE is atomic on its own; executor-aware for callers
   * that need to compose it under a parent transaction.
   */
  async deleteAllForExpert(expertProfileId: string, executor?: DbExecutor): Promise<void> {
    const exec = executor ?? db;
    await exec
      .update(availabilityRules)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(availabilityRules.expertProfileId, expertProfileId),
          isNull(availabilityRules.deletedAt)
        )
      );
  },

  /**
   * True when the expert has at least one active (non-deleted) rule. Used by the
   * onboarding checklist to decide whether "Set your availability" is complete.
   * `findFirst` compiles to a `SELECT ... LIMIT 1` so it short-circuits.
   */
  async hasActiveRules(expertProfileId: string): Promise<boolean> {
    const row = await db.query.availabilityRules.findFirst({
      where: and(
        eq(availabilityRules.expertProfileId, expertProfileId),
        isNull(availabilityRules.deletedAt)
      ),
      columns: { id: true },
    });
    return row !== undefined;
  },
};
