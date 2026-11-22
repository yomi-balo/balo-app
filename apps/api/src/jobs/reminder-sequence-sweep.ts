import { randomUUID } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import { usersRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import {
  REMINDER_SEQUENCE_STEPS,
  reminderRecipientZone,
  reminderSequenceKey,
} from '@balo/shared/notifications';
import { createRedisConnection } from '../lib/redis.js';
import { getQueue } from '../lib/queue.js';
import { mapWithConcurrency } from '../lib/map-with-concurrency.js';
import { scheduleNotification } from '../notifications/scheduling/schedule.js';
import { isScheduledKeyDecided } from '../notifications/scheduling/scheduled-key-decided.js';
import { planDueSteps } from '../notifications/sequences/plan.js';
import {
  REARMABLE_REMINDER_SKIP_REASONS,
  REMINDER_SEQUENCE_RECHECK,
} from '../notifications/sequences/recheck.js';
import { allReminderSequences } from '../notifications/sequences/registry.js';
import type {
  AnyReminderSequence,
  ReminderCadence,
  SequenceEntity,
} from '../notifications/sequences/types.js';

/**
 * BAL-663 — the reminder-sequence sweep. Each tick asks every registered sequence of this
 * cadence for the entities that wait, and arms each due step per recipient as an ADR-1047
 * promise (`scheduleNotification`). Whether a promise still deserves to send is decided later by
 * the `reminder_sequence` recheck at fire time; this sweep only arms.
 *
 * A step is armed once per key: a key that has been published, is in flight, or was skipped for
 * a final reason is never armed again, and a still-pending key folds (`first_wins`).
 */
export const REMINDER_SEQUENCE_SWEEP_QUEUE = 'reminder-sequence-sweep';

export const REMINDER_SEQUENCE_SWEEP_CRONS: Readonly<Record<ReminderCadence, string>> = {
  hourly: '20 * * * *',
};

/** Static job names: a repeatable has no dynamic part, so no custom `jobId`. */
export const REMINDER_SEQUENCE_SWEEP_JOB_NAMES: Readonly<Record<ReminderCadence, string>> = {
  hourly: 'sweep-hourly',
};

/** How far ahead of its send time a step is armed: one cadence period. */
export const REMINDER_SEQUENCE_SWEEP_LEAD_MS: Readonly<Record<ReminderCadence, number>> = {
  hourly: 60 * 60 * 1000,
};

/** Entities armed at once per sequence; bounds DB load when a backlog arrives. */
export const REMINDER_SEQUENCE_ENTITY_CONCURRENCY = 4;

const REMINDER_CADENCES: readonly ReminderCadence[] = ['hourly'];

const logger = createLogger('reminder-sequence-sweep');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export interface ReminderSequenceSweepResult {
  readonly armed: number;
  readonly entities: number;
}

async function armRecipient(
  sequence: AnyReminderSequence,
  entity: SequenceEntity,
  userId: string,
  now: Date,
  leadMs: number
): Promise<number> {
  const context = await usersRepository.findTimezoneContext(userId, undefined);
  const zone = reminderRecipientZone(context?.savedTimezone);
  const anchorIso = entity.anchor.toISOString();
  const due = planDueSteps({
    steps: REMINDER_SEQUENCE_STEPS[sequence.id],
    anchor: entity.anchor,
    now,
    leadMs,
    zone,
  });

  const armedPerStep = await Promise.all(
    due.map(async ({ stepKey, fireAt }) => {
      const key = reminderSequenceKey({
        sequenceId: sequence.id,
        entityId: entity.entityId,
        stepKey,
        userId,
        anchorIso,
      });
      if (await isScheduledKeyDecided(key, REARMABLE_REMINDER_SKIP_REASONS)) {
        return 0;
      }
      const { outcome } = await scheduleNotification(
        sequence.event,
        sequence.buildPayload(entity, stepKey, userId, randomUUID()),
        { key, at: fireAt, mode: 'first_wins', recheck: REMINDER_SEQUENCE_RECHECK }
      );
      logger.info(
        { sequence: sequence.id, step: stepKey, entityId: entity.entityId, outcome },
        'Reminder step armed'
      );
      return outcome === 'scheduled' ? 1 : 0;
    })
  );
  return sum(armedPerStep);
}

type FindResult =
  | { readonly ok: true; readonly entities: readonly SequenceEntity[] }
  | { readonly ok: false };

/** One sequence's waiting entities. A failing `find` is logged and ends only that sequence. */
async function findEntities(
  sequence: AnyReminderSequence,
  now: Date,
  jobLog: (message: string) => void
): Promise<FindResult> {
  try {
    return { ok: true, entities: await sequence.find(now) };
  } catch (error) {
    const message = errorMessage(error);
    jobLog(`reminder sequence ${sequence.id} could not list entities: ${message}`);
    logger.error(
      {
        sequence: sequence.id,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Reminder sequence find failed'
    );
    return { ok: false };
  }
}

/** Arms one entity for every recipient. A failure is logged and never aborts the batch. */
async function armEntity(
  sequence: AnyReminderSequence,
  entity: SequenceEntity,
  now: Date,
  leadMs: number,
  jobLog: (message: string) => void
): Promise<number> {
  try {
    const recipients = await sequence.resolveRecipients(entity);
    const armedPerRecipient = await Promise.all(
      recipients.map((userId) => armRecipient(sequence, entity, userId, now, leadMs))
    );
    return sum(armedPerRecipient);
  } catch (error) {
    const message = errorMessage(error);
    jobLog(`reminder sequence ${sequence.id} failed for ${entity.entityId}: ${message}`);
    logger.error(
      {
        sequence: sequence.id,
        entityId: entity.entityId,
        error: message,
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Reminder sequence entity failed'
    );
    return 0;
  }
}

/**
 * The sweep body (exported for unit testing without a Redis-backed Worker). Each entity is
 * isolated in its own try/catch, so one bad entity never aborts the batch.
 */
export async function runReminderSequenceSweep(
  now: Date,
  cadence: ReminderCadence,
  jobLog: (message: string) => void = () => {}
): Promise<ReminderSequenceSweepResult> {
  const leadMs = REMINDER_SEQUENCE_SWEEP_LEAD_MS[cadence];
  const perSequence = await Promise.all(
    allReminderSequences()
      .filter((sequence) => sequence.cadence === cadence)
      .map(async (sequence) => {
        const found = await findEntities(sequence, now, jobLog);
        if (!found.ok) {
          return { armed: 0, entities: 0 };
        }
        logger.info(
          { sequence: sequence.id, cadence, entities: found.entities.length },
          'Reminder sequence entities found'
        );
        const armedPerEntity = await mapWithConcurrency(
          found.entities,
          REMINDER_SEQUENCE_ENTITY_CONCURRENCY,
          (entity) => armEntity(sequence, entity, now, leadMs, jobLog)
        );
        return { armed: sum(armedPerEntity), entities: found.entities.length };
      })
  );
  const armed = sum(perSequence.map((result) => result.armed));
  const entityCount = sum(perSequence.map((result) => result.entities));

  logger.info({ cadence, armed, entities: entityCount }, 'Reminder sequence sweep complete');
  jobLog(`reminder sequence sweep (${cadence}): ${armed} armed across ${entityCount} entities`);
  return { armed, entities: entityCount };
}

/** Start the reminder-sequence sweep worker (concurrency 1). */
export function startReminderSequenceSweepWorker(): Worker {
  return new Worker(
    REMINDER_SEQUENCE_SWEEP_QUEUE,
    async (job: Job) => {
      const { cadence } = job.data as { cadence: ReminderCadence };
      await runReminderSequenceSweep(new Date(), cadence, (m) => job.log(m));
    },
    { connection: createRedisConnection(), concurrency: 1 }
  );
}

/** Register one repeatable per cadence. */
export async function registerReminderSequenceSweepCron(): Promise<void> {
  const queue = getQueue(REMINDER_SEQUENCE_SWEEP_QUEUE);
  await Promise.all(
    REMINDER_CADENCES.map((cadence) =>
      queue.add(
        REMINDER_SEQUENCE_SWEEP_JOB_NAMES[cadence],
        { cadence },
        { repeat: { pattern: REMINDER_SEQUENCE_SWEEP_CRONS[cadence] }, removeOnComplete: true }
      )
    )
  );
}
