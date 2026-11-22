import {
  REMINDER_ARMABLE_AFTER_DUE_MS,
  reminderSendAt,
  type ReminderStep,
} from '@balo/shared/notifications';

const MINUTE_MS = 60_000;

export interface PlannedStep {
  readonly stepKey: string;
  readonly fireAt: Date;
}

/**
 * The steps a sweep should arm now. A step's send time is its offset from the anchor with the
 * step's timing window applied; it is armable from one `leadMs` before that send time until
 * `REMINDER_ARMABLE_AFTER_DUE_MS` after it. The 24-hour grace is measured on the SEND time, so
 * a Saturday step still arms for Monday 09:00, and an outage never releases an older backlog.
 *
 * Send times are worked out for every step, in order, before the armable window is applied. A
 * `weekday_morning` step whose send time would not be strictly after the previous step's moves to
 * the next weekday morning, so two steps never land on the same morning. The step keys do not
 * change, so a moved step is still armed once.
 */
export function planDueSteps(input: {
  steps: readonly ReminderStep[];
  anchor: Date;
  now: Date;
  leadMs: number;
  zone: string;
}): PlannedStep[] {
  const earliest = input.now.getTime() - REMINDER_ARMABLE_AFTER_DUE_MS;
  const latest = input.now.getTime() + input.leadMs;
  const planned: PlannedStep[] = [];
  let previousFireAt: Date | null = null;
  for (const step of input.steps) {
    const dueAt = new Date(input.anchor.getTime() + step.offsetMinutes * MINUTE_MS);
    let fireAt = reminderSendAt(dueAt, step.timing, input.zone);
    if (
      step.timing === 'weekday_morning' &&
      previousFireAt !== null &&
      fireAt.getTime() <= previousFireAt.getTime()
    ) {
      fireAt = reminderSendAt(
        new Date(previousFireAt.getTime() + 1),
        'weekday_morning',
        input.zone
      );
    }
    previousFireAt = fireAt;
    if (fireAt.getTime() >= earliest && fireAt.getTime() <= latest) {
      planned.push({ stepKey: step.key, fireAt });
    }
  }
  return planned;
}
