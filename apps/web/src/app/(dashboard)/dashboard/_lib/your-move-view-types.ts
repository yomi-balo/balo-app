import type {
  DashboardTrackStage,
  DashboardTrackTurn,
  DashboardYourMoveCardKind,
  DashboardYourMoveChip,
} from '@balo/analytics/events';
import type { PortfolioRowView } from '@/lib/projects-inbox/portfolio-row';

/**
 * The Your move rail's and project track's client-safe view model. Types and constants only:
 * imported by the server-side builders and by the client rail and track. NO money (budget, price, rate, balance) crosses
 * this boundary. The counterparty follows a per-side rule: expert cards name the client company,
 * never a person; client cards name the expert as "person, agency" (Balo on the exploratory call,
 * the company on Team, a hold line on Billing). Team cards may carry requester names and emails.
 */

export type YourMoveWorkspaceType = 'company' | 'expert';

export type YourMoveGateState = 'done' | 'yours' | 'pending';

/** The read-only body of one card. The action always opens the owning page. */
export type YourMoveContext =
  | {
      readonly type: 'brief';
      readonly excerpt: string | null;
      readonly tags: readonly string[];
      readonly timeline: string | null;
    }
  | { readonly type: 'sentence'; readonly body: string }
  | { readonly type: 'draft'; readonly label: string }
  | {
      readonly type: 'message';
      readonly from: string;
      readonly at: string | null;
      readonly snippet: string;
    }
  | { readonly type: 'change_note'; readonly note: string; readonly section: string | null }
  | {
      readonly type: 'gates';
      readonly gates: readonly { readonly label: string; readonly state: YourMoveGateState }[];
      readonly note: string | null;
    }
  | {
      readonly type: 'delivery';
      readonly note: string;
      readonly done: number;
      readonly total: number;
    }
  | {
      readonly type: 'items';
      readonly items: readonly { readonly text: string; readonly overdue: boolean }[];
      readonly more: number;
    }
  | {
      readonly type: 'stats';
      readonly stats: readonly { readonly label: string; readonly value: string }[];
    }
  | {
      readonly type: 'reschedule';
      readonly wasIso: string;
      readonly optionIsos: readonly string[];
    }
  | {
      readonly type: 'completion';
      readonly done: number;
      readonly total: number;
      readonly autoAcceptIso: string | null;
    }
  | {
      readonly type: 'people';
      readonly people: readonly { readonly name: string; readonly email: string }[];
      readonly more: number;
    };

/** A fact whose day is formatted in the viewer's device zone, client-side. */
export interface YourMoveFactAt {
  readonly template: 'reply_by' | 'since' | 'marked_complete';
  readonly iso: string;
}

export interface YourMoveCardView {
  readonly id: string;
  readonly kind: DashboardYourMoveCardKind;
  readonly title: string;
  /**
   * Expert kinds: the client company (or a short status line on the calendar card), never a
   * person. Client kinds: "person, agency", Balo, the company, or a hold line.
   */
  readonly counterparty: string;
  /** Server-formatted relative fact. Never set together with `factAt`. */
  readonly fact: string | null;
  /** A dated fact rendered in the viewer's zone. Never set together with `fact`. */
  readonly factAt: YourMoveFactAt | null;
  readonly factTone: 'muted' | 'warning';
  readonly actionLabel: string;
  readonly href: string;
  /** ISO. Sort key and tiebreak. */
  readonly waitingSince: string;
  /** ISO. Always null for expert kinds today; kept for the shared sort. */
  readonly deadline: string | null;
  readonly context: YourMoveContext | null;
}

export type YourMoveData = {
  readonly kind: 'ready' | 'error';
  readonly cards: readonly YourMoveCardView[];
};

/** What the loaders return: the rail's cards plus the live rows the track is built from. */
export interface YourMoveRead {
  readonly cards: readonly YourMoveCardView[];
  readonly rows: readonly PortfolioRowView[];
}

/**
 * The server-side read result. Rows carry person names, so they stay on the server: the slot
 * builds the track view from them and hands the client rail only `YourMoveData`.
 */
export type YourMoveReadData = YourMoveData & { readonly rows: readonly PortfolioRowView[] };

export const YOUR_MOVE_CARD_VIEW_KEYS = [
  'id',
  'kind',
  'title',
  'counterparty',
  'fact',
  'factAt',
  'factTone',
  'actionLabel',
  'href',
  'waitingSince',
  'deadline',
  'context',
] as const satisfies readonly (keyof YourMoveCardView)[];

type _MissingKey = Exclude<keyof YourMoveCardView, (typeof YOUR_MOVE_CARD_VIEW_KEYS)[number]>;
export const ASSERT_YOUR_MOVE_KEYS_COMPLETE = true satisfies _MissingKey extends never
  ? true
  : never;

/** Every key that appears on any {@link YourMoveContext} variant (pinned money-free by test). */
export const YOUR_MOVE_CONTEXT_KEYS = [
  'type',
  'excerpt',
  'tags',
  'timeline',
  'body',
  'label',
  'from',
  'at',
  'snippet',
  'note',
  'section',
  'gates',
  'state',
  'done',
  'total',
  'items',
  'text',
  'overdue',
  'more',
  'stats',
  'value',
  'wasIso',
  'optionIsos',
  'autoAcceptIso',
  'people',
  'name',
  'email',
] as const;

type ContextKeysOf<T> = T extends unknown ? keyof T : never;
type _MissingContextKey = Exclude<
  ContextKeysOf<YourMoveContext> | 'state' | 'text' | 'overdue' | 'value' | 'name' | 'email',
  (typeof YOUR_MOVE_CONTEXT_KEYS)[number]
>;
export const ASSERT_YOUR_MOVE_CONTEXT_KEYS_COMPLETE =
  true satisfies _MissingContextKey extends never ? true : never;

export type YourMoveTone = 'warning' | 'violet' | 'primary' | 'slate';

export interface YourMoveKindMeta {
  readonly label: string;
  readonly chip: Exclude<DashboardYourMoveChip, 'all'>;
  readonly chipLabel: string;
  /** 0 blocks bookings or money; 1 someone is waiting on the viewer; 2 work owed, nobody blocked. */
  readonly tier: 0 | 1 | 2;
  readonly action: string;
  readonly tone: YourMoveTone;
  /** Which workspace's rail the kind appears on. */
  readonly side: 'expert' | 'client' | 'both';
}

export const YOUR_MOVE_KIND_META: Record<DashboardYourMoveCardKind, YourMoveKindMeta> = {
  calendar_reconnect: {
    label: 'Calendar',
    chip: 'calendar',
    chipLabel: 'Calendar',
    tier: 0,
    action: 'Reconnect calendar',
    tone: 'warning',
    side: 'expert',
  },
  invitation: {
    label: 'Project invitation',
    chip: 'invitations',
    chipLabel: 'Invitations',
    tier: 1,
    action: 'Review invitation',
    tone: 'violet',
    side: 'expert',
  },
  eoi_followup: {
    label: 'Interest sent',
    chip: 'interest',
    chipLabel: 'Interest',
    tier: 1,
    action: 'Propose times',
    tone: 'violet',
    side: 'expert',
  },
  proposal_requested: {
    label: 'Proposal requested',
    chip: 'proposals',
    chipLabel: 'Proposals',
    tier: 1,
    action: 'Write proposal',
    tone: 'violet',
    side: 'expert',
  },
  changes_requested: {
    label: 'Proposal changes',
    chip: 'proposals',
    chipLabel: 'Proposals',
    tier: 1,
    action: 'Revise proposal',
    tone: 'violet',
    side: 'expert',
  },
  delivery_changes: {
    label: 'Delivery changes',
    chip: 'delivery',
    chipLabel: 'Delivery',
    tier: 1,
    action: 'Open project',
    tone: 'violet',
    side: 'expert',
  },
  action_items: {
    label: 'Action items',
    chip: 'action_items',
    chipLabel: 'Action items',
    tier: 2,
    action: 'View items',
    tone: 'primary',
    side: 'both',
  },
  messages: {
    label: 'Messages',
    chip: 'messages',
    chipLabel: 'Messages',
    tier: 2,
    action: 'Open messages',
    tone: 'slate',
    side: 'both',
  },
  receivable: {
    label: 'Billing',
    chip: 'billing',
    chipLabel: 'Billing',
    tier: 0,
    action: 'Settle balance',
    tone: 'warning',
    side: 'client',
  },
  reschedule: {
    label: 'New times suggested',
    chip: 'new_times',
    chipLabel: 'New times',
    tier: 1,
    action: 'Choose a time',
    tone: 'primary',
    side: 'client',
  },
  completion: {
    label: 'Work to review',
    chip: 'work_to_review',
    chipLabel: 'Work to review',
    tier: 1,
    action: 'Review work',
    tone: 'violet',
    side: 'client',
  },
  kickoff_billing: {
    label: 'Kickoff',
    chip: 'kickoff',
    chipLabel: 'Kickoff',
    tier: 1,
    action: 'Confirm billing',
    tone: 'violet',
    side: 'client',
  },
  kickoff_payment: {
    label: 'Kickoff',
    chip: 'kickoff',
    chipLabel: 'Kickoff',
    tier: 1,
    action: 'Pay invoice',
    tone: 'violet',
    side: 'client',
  },
  exploratory_call: {
    label: 'Exploratory call',
    chip: 'calls',
    chipLabel: 'Calls',
    tier: 1,
    action: 'Book a call',
    tone: 'violet',
    side: 'client',
  },
  eoi_reply: {
    label: 'In conversation',
    chip: 'replies',
    chipLabel: 'Replies',
    tier: 1,
    action: 'Reply',
    tone: 'violet',
    side: 'client',
  },
  proposal_review: {
    label: 'Proposal to review',
    chip: 'proposals',
    chipLabel: 'Proposals',
    tier: 1,
    action: 'Review proposal',
    tone: 'violet',
    side: 'client',
  },
  join_requests: {
    label: 'Team',
    chip: 'team',
    chipLabel: 'Team',
    tier: 1,
    action: 'Review requests',
    tone: 'slate',
    side: 'client',
  },
};

/** One project on the "Where your projects stand" track. The only row data that reaches it. */
export interface ProjectTrackToken {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly href: string;
  readonly turn: DashboardTrackTurn;
}

export interface ProjectTrackStage {
  readonly key: DashboardTrackStage;
  readonly label: string;
  readonly explanation: string;
  readonly tokens: readonly ProjectTrackToken[];
  readonly hasYourMove: boolean;
}

export interface ProjectTrackView {
  readonly workspaceType: YourMoveWorkspaceType;
  readonly stages: readonly ProjectTrackStage[];
}

interface TrackCopy {
  readonly title: string;
  readonly sub: string;
  readonly waiting: string;
}

export const PROJECT_TRACK_COPY: Record<YourMoveWorkspaceType, TrackCopy> = {
  expert: {
    title: 'Where your projects stand',
    sub: 'Every live project, and whose move it is.',
    waiting: 'Waiting on client',
  },
  company: {
    title: 'Where your projects stand',
    sub: 'Every open request and project, and whose move it is.',
    waiting: 'Waiting on others',
  },
};

export const PROJECT_TRACK_YOUR_MOVE = 'Your move';
export const PROJECT_TRACK_IN_PROGRESS = 'In progress';
export const PROJECT_TRACK_NONE = 'None';
