import type {
  ExpertChecklistItemKey,
  ExpertLiveState,
  LiveStatusAction,
} from '@balo/shared/experts';
import { CHECKLIST_ITEMS, expertSettingsHrefFor } from '@/lib/constants/expert-checklist';

export interface LiveStatusPrimary {
  readonly label: string;
  readonly action: LiveStatusAction;
  readonly href: string;
}

export interface LiveStatusCopy {
  readonly pill: string;
  readonly title: string;
  readonly body: string;
  readonly primary: LiveStatusPrimary | null;
}

const RECONNECT_CALENDAR: LiveStatusPrimary = {
  label: 'Reconnect calendar',
  action: 'reconnect_calendar',
  href: expertSettingsHrefFor('calendar'),
};

/** Copy from the LIVE_STATES record in `dashboard-attention.jsx`. */
const LIVE_STATUS_COPY: Record<ExpertLiveState, LiveStatusCopy> = {
  live: {
    pill: 'Live',
    title: "You're live on the marketplace",
    body: 'Clients can find you in search and book you.',
    primary: null,
  },
  paused: {
    pill: 'Bookings paused',
    title: 'Bookings are paused',
    body: "You still appear in search, but clients can't book you until your calendar is reconnected.",
    primary: RECONNECT_CALENDAR,
  },
  away: {
    pill: 'Not taking work',
    title: "You're not taking on new work",
    body: 'You still appear in search, but clients are offered a similar expert instead of booking you.',
    primary: {
      label: 'Change availability',
      action: 'change_availability',
      href: '/expert/settings?tab=schedule',
    },
  },
  not_listed: {
    pill: 'Not listed',
    title: "You're not in search right now",
    body: "Clients can't find you until your calendar is reconnected.",
    primary: RECONNECT_CALENDAR,
  },
};

/** Dot and pill classes per state — semantic tokens only. */
export const LIVE_STATUS_TOKENS: Record<ExpertLiveState, { dot: string; pill: string }> = {
  live: { dot: 'bg-success', pill: 'bg-success/10 text-success-strong' },
  paused: { dot: 'bg-warning', pill: 'bg-warning/10 text-warning-strong' },
  away: { dot: 'bg-paused-border', pill: 'bg-paused-surface text-muted-foreground' },
  not_listed: { dot: 'bg-subtle-foreground', pill: 'bg-paused-surface text-muted-foreground' },
};

/** `not_listed` for a cause the design does not cover: a failing non-calendar item, or none. */
function notListedCopy(fixItem: ExpertChecklistItemKey | null): LiveStatusCopy {
  const base = LIVE_STATUS_COPY.not_listed;
  if (fixItem === null) {
    return { ...base, body: "Clients can't find you right now.", primary: null };
  }
  const item = CHECKLIST_ITEMS.find((entry) => entry.key === fixItem);
  if (item === undefined) return base;
  return {
    ...base,
    body: "Clients can't find you until your setup is complete.",
    primary: { label: item.label, action: 'finish_setup', href: expertSettingsHrefFor(item.key) },
  };
}

export function liveStatusCopyFor(status: {
  readonly state: ExpertLiveState;
  readonly fixItem: ExpertChecklistItemKey | null;
}): LiveStatusCopy {
  if (status.state === 'not_listed' && status.fixItem !== 'calendar') {
    return notListedCopy(status.fixItem);
  }
  return LIVE_STATUS_COPY[status.state];
}
