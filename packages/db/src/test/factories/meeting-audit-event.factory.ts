import { db } from '../../client';
import { auditEvents } from '../../schema';
import type { MeetingAuditAction } from '../../repositories/_shared/meeting-audit';

interface MeetingAuditEventFactoryInput {
  meetingId: string;
  action: MeetingAuditAction;
  /**
   * REQUIRED, no default: `defaultNow()` is the per-test transaction's start, shared by every
   * row the test writes, and the case-inactivity seam reads exactly this column.
   */
  createdAt: Date;
  /** The acting user; defaults to NULL (a seeded or system write). */
  actorUserId?: string | null;
}

/**
 * Seeds ONE meeting audit row (`entity_type = 'meeting'`, `entity_id = meetingId`) with a
 * controlled `createdAt` and, unless `actorUserId` is passed, a NULL actor.
 *
 * Inserts DIRECTLY via `db`: `auditEventsRepository.record` takes no `createdAt`. Metadata is
 * left NULL — nothing that reads these rows for a timestamp reads their metadata.
 *
 * `meetingFactory` writes NO audit row, so a factory meeting has no `meeting.booked` history
 * until a test seeds one here.
 */
export async function meetingAuditEventFactory(
  input: MeetingAuditEventFactoryInput
): Promise<{ id: string; createdAt: Date }> {
  const [row] = await db
    .insert(auditEvents)
    .values({
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      entityType: 'meeting',
      entityId: input.meetingId,
      createdAt: input.createdAt,
    })
    .returning({ id: auditEvents.id, createdAt: auditEvents.createdAt });
  if (row === undefined) {
    throw new Error('meeting audit event insert failed');
  }
  return row;
}
