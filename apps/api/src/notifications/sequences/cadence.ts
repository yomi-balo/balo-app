import type { ReminderCadence } from './types.js';

/** How far ahead of its send time a step is armed: one cadence period. */
export const REMINDER_SEQUENCE_SWEEP_LEAD_MS: Readonly<Record<ReminderCadence, number>> = {
  hourly: 60 * 60 * 1000,
};
