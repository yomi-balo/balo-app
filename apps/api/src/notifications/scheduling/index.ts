export {
  scheduleNotification,
  cancelScheduledNotification,
  InvalidScheduleOptionsError,
} from './schedule.js';
export type {
  ScheduleOptions,
  ScheduleResult,
  ScheduleExecutor,
  SchedulableNotificationEvent,
} from './schedule.js';

export { SCHEDULED_RECHECKS, runRecheck, UnknownRecheckError } from './rechecks.js';
export type { RecheckResult, ScheduledRecheck } from './rechecks.js';

// BAL-424 — BAL-420's FIRST consumer: the debounced conversation unread digest.
export {
  conversationUnreadKey,
  conversationUnreadRecheck,
  scheduleConversationUnreadDigest,
  CONVERSATION_UNREAD_DELAY_MS,
  CONVERSATION_UNREAD_RECHECK,
} from './conversation-unread.js';
export type { ScheduleConversationUnreadDigestInput } from './conversation-unread.js';

// BAL-134 — the two meeting-absence promises and their fire-time guards.
export {
  clientAbsentKey,
  expertAbsentKey,
  meetingClientAbsentRecheck,
  meetingExpertAbsentRecheck,
  scheduleClientAbsentNudge,
  scheduleExpertAbsentAlert,
  MEETING_CLIENT_ABSENT_RECHECK,
  MEETING_EXPERT_ABSENT_RECHECK,
} from './meeting-absence.js';
export type {
  ScheduleClientAbsentNudgeInput,
  ScheduleExpertAbsentAlertInput,
} from './meeting-absence.js';
