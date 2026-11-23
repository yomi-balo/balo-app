import {
  REMINDER_ARMABLE_AFTER_DUE_MS,
  reminderStepSendTimes,
  type ReminderStep,
  type ReminderStepSendTime,
} from '@balo/shared/notifications';

export type PlannedStep = ReminderStepSendTime;

/**
 * The steps a sweep should arm now. Send times come from `reminderStepSendTimes`, which applies
 * each step's timing window and keeps two `weekday_morning` steps off the same morning. A step
 * is armable from one `leadMs` before its send time until `REMINDER_ARMABLE_AFTER_DUE_MS` after
 * it. The 24-hour grace is measured on the SEND time, so a Saturday step still arms for Monday
 * 09:00, and an outage never releases an older backlog. A moved step keeps its key, so it is
 * still armed once.
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
  return reminderStepSendTimes(input).filter(
    ({ fireAt }) => fireAt.getTime() >= earliest && fireAt.getTime() <= latest
  );
}
