import { db } from '../../client';
import { meetings, meetingContexts } from '../../schema';
import type { Meeting, NewMeeting, MeetingContext, MeetingContextType } from '../../schema';
import { caseEngagementFactory } from './case-engagement.factory';

const HOUR_MS = 3_600_000;

/** One context attachment — mirrors `meetingsRepository`'s `MeetingContextInput`. */
export interface MeetingFactoryContext {
  contextType: MeetingContextType;
  /** NULL only for `'admin'` (the DB CHECK enforces the biconditional). */
  contextId: string | null;
}

interface MeetingFactoryOverrides {
  /**
   * The context rows to attach. Defaults to ONE `case` row over a fresh
   * `caseEngagementFactory()`. Pass `[]` to seed a meeting with NO context row — legal at
   * the DB level (the ≥1 invariant lives on `meetingsRepository.create`), and the only way
   * to exercise that gap.
   */
  contexts?: MeetingFactoryContext[];
  /** Row-level overrides (status, outcome, scheduledStart/End, dailyRoomName, deletedAt, …). */
  values?: Partial<NewMeeting>;
}

export interface MeetingFactoryResult {
  meeting: Meeting;
  contexts: MeetingContext[];
  /** The engagement the DEFAULT `case` context points at; absent when `contexts` was passed. */
  caseEngagementId?: string;
}

/**
 * Seeds one `meetings` row (default `status='scheduled'`, `scheduled_start = now + 1h`,
 * `scheduled_end = now + 2h`) plus its context rows.
 *
 * Inserts DIRECTLY via `db` (not `meetingsRepository.create`) on purpose: the repository
 * refuses an empty `contexts` array and exposes no status mutator (BAL-134 owns the
 * transitions), so tests could not otherwise seed an `ended`/`in_progress`/soft-deleted
 * meeting. The `transcript.factory` precedent.
 *
 * ⚠ `values.deletedAt` is NOT propagated to the context rows — a soft-deleted meeting with
 * LIVE context rows is exactly the state the BAL-425 read must exclude, and propagating
 * would make that assertion vacuous. Soft-delete both via `meetingsRepository.softDelete`.
 */
export async function meetingFactory(
  overrides: MeetingFactoryOverrides = {}
): Promise<MeetingFactoryResult> {
  let caseEngagementId: string | undefined;
  let contextInputs = overrides.contexts;
  if (contextInputs === undefined) {
    caseEngagementId = (await caseEngagementFactory()).engagement.id;
    contextInputs = [{ contextType: 'case', contextId: caseEngagementId }];
  }

  const now = Date.now();

  const [meeting] = await db
    .insert(meetings)
    .values({
      scheduledStart: new Date(now + HOUR_MS),
      scheduledEnd: new Date(now + 2 * HOUR_MS),
      ...overrides.values,
    })
    .returning();
  if (meeting === undefined) {
    throw new Error('meeting insert failed');
  }

  const contexts =
    contextInputs.length === 0
      ? []
      : await db
          .insert(meetingContexts)
          .values(
            contextInputs.map((context) => ({
              meetingId: meeting.id,
              contextType: context.contextType,
              contextId: context.contextId,
            }))
          )
          .returning();

  return { meeting, contexts, caseEngagementId };
}
