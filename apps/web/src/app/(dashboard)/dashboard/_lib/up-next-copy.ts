import type { UpNextWorkspaceType } from './up-next-view-types';

/**
 * BAL-566 — EVERY Up next string, in one place. All copy is gender-neutral (CLAUDE.md). D17: MJ
 * copy sign-off is pending on every string here, the banner copy and the help doc — flagged in
 * the PR body, and does not block the build.
 */

export const UP_NEXT_TITLE = 'Up next';
export const UP_NEXT_BALO_PARTY_NAME = 'Balo';

export interface UpNextWorkspaceCopy {
  readonly subtitle: (companyName: string) => string;
  readonly emptyBody: string;
  readonly rescheduleNote: string;
}

export const UP_NEXT_COPY: Readonly<Record<UpNextWorkspaceType, UpNextWorkspaceCopy>> = {
  company: {
    subtitle: (companyName: string) => `Meetings across ${companyName}’s cases and projects`,
    emptyBody: 'Find an expert and pick a time.',
    rescheduleNote: 'New times suggested',
  },
  expert: {
    // The expert subtitle never names a company — it is not part of its template's inputs.
    subtitle: () => 'Your meetings across cases and projects',
    emptyBody: 'New bookings show up here and in Calendar.',
    rescheduleNote: 'Waiting on their reply',
  },
};

export const UP_NEXT_EMPTY_TITLE = 'Nothing booked';
export const UP_NEXT_FIND_EXPERT = 'Find an expert';
export const UP_NEXT_FIND_EXPERT_HREF = '/experts';
export const UP_NEXT_OPEN_CALENDAR = 'Open calendar';
export const UP_NEXT_HAPPENING_NOW = 'Happening now';
export const upNextStartsIn = (minutes: number): string => `Starts in ${minutes} min`;
export const UP_NEXT_JOIN = 'Join';
export const UP_NEXT_ERROR = 'We couldn’t load your upcoming meetings.';
export const UP_NEXT_RETRY = 'Try again';

export const CALENDAR_DISCONNECTED_TITLE = 'Your calendar is disconnected';
export const CALENDAR_DISCONNECTED_BODY =
  'While it’s disconnected, you won’t appear in expert search.';
export const CALENDAR_DISCONNECTED_CTA = 'Reconnect';
