export { notificationEvents } from './publisher.js';
export type { NotificationEvent, EventPayloadMap } from './events.js';
export type { NotificationChannel } from './engine/rules.js';

// BAL-420 (ADR-1047) — the in-process scheduling surface. No HTTP route for `schedule`
// (Decision 10: no web-schedulable event exists yet) and none EVER for `cancel`
// (Decision 11: it is a suppression primitive against Balo's own alerting).
export { WEB_SCHEDULABLE_EVENTS } from './events.js';
export type { WebSchedulableNotificationEvent } from './events.js';
export {
  scheduleNotification,
  cancelScheduledNotification,
  InvalidScheduleOptionsError,
  SCHEDULED_RECHECKS,
  runRecheck,
  UnknownRecheckError,
} from './scheduling/index.js';
export type {
  ScheduleOptions,
  ScheduleResult,
  ScheduleExecutor,
  SchedulableNotificationEvent,
  RecheckResult,
  ScheduledRecheck,
} from './scheduling/index.js';
