import { auditEventsRepository } from '../audit-events';
import type { DbExecutor } from './db-executor';

/**
 * Schedule/timezone audit vocabulary (BAL-234 / ADR-1030). `audit_events`
 * (BAL-344) stores `action`/`entityType` as open `text`, so this union keeps OUR
 * emitted taxonomy typo-safe at compile time. Mirrors `_shared/action-item-audit.ts`.
 */
export type ScheduleAuditAction =
  | 'expert_schedule.updated'
  | 'expert_schedule.cleared'
  | 'expert_timezone.changed';

/**
 * Record ONE schedule/timezone audit event inside the caller's transaction (pass
 * the `tx` handle — it satisfies `DbExecutor`). The entity is the expert_profiles
 * row. For a timezone change, pass `{ oldTimezone, newTimezone }` in `metadata`:
 * the timezone is updated in place (the prior value is otherwise overwritten and
 * unrecoverable) and it shifts every bookable slot, so support needs both values
 * to reconstruct what the expert's availability meant before the change.
 */
export async function recordScheduleAudit(
  exec: DbExecutor,
  input: {
    actorUserId: string | null;
    action: ScheduleAuditAction;
    expertProfileId: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await auditEventsRepository.record(
    {
      actorUserId: input.actorUserId,
      action: input.action,
      entityType: 'expert_profile',
      entityId: input.expertProfileId,
      metadata: input.metadata ?? null,
    },
    exec
  );
}
