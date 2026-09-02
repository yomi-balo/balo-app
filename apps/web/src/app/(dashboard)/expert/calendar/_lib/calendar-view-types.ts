/**
 * BAL-498 — plain, ISO-serialised view types passed from the Calendar RSC down to
 * `CalendarShell`. Serialisable across the RSC→client boundary (precedent:
 * `join/[token]/recap/_lib/guest-recap-view-types.ts`).
 */
import type { MeetingContextTypeWithHolder, MeetingLifecycleStatus } from '@balo/shared/meetings';

export interface CalendarMeetingView {
  readonly meetingId: string;
  /** ISO instant — source of truth is `meetings.scheduledStart`. */
  readonly scheduledStart: string;
  readonly scheduledEnd: string;
  /** Never `'cancelled'` (filtered both sides by the repository). Drives the Join affordance's
   *  terminal-status gate (`meetingIsClosedToJoin`, BAL-513 C2.4) — see `join-window.ts`. */
  readonly status: MeetingLifecycleStatus;
  readonly contextType: MeetingContextTypeWithHolder;
  /** Link to the owning engagement/request detail. `null` when the owning row is not live. */
  readonly href: string | null;
  /** The tokenless anonymous-lobby URL, built server-side via `meetingJoinLinkUrl`. */
  readonly joinUrl: string;
  /** The CLIENT COMPANY. `null` when the owning row is absent/soft-deleted. */
  readonly counterpartyCompanyName: string | null;
}

export interface CalendarPageView {
  readonly expertProfileId: string;
  /** `expert_profiles.timezone` — the ONE zone every rendered time uses. */
  readonly timezone: string;
  readonly meetings: readonly CalendarMeetingView[];
  /** Empty state (a) precedence — keyed on the checklist item, never on meeting count. */
  readonly hasConnectedCalendar: boolean;
}
