import type { DashboardYourMoveCardKind, DashboardYourMoveChip } from '@balo/analytics/events';

/**
 * The Your move rail's client-safe view model. Types and constants only: imported by the
 * server-only builder and by the client rail. NO money (budget, price, rate, balance) and no
 * person's name crosses this boundary; the counterparty is always a company.
 */

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
    };

export interface YourMoveCardView {
  readonly id: string;
  readonly kind: DashboardYourMoveCardKind;
  readonly title: string;
  /** The client company (or a short status line on the calendar card). Never a person. */
  readonly counterparty: string;
  readonly fact: string | null;
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

export const YOUR_MOVE_CARD_VIEW_KEYS = [
  'id',
  'kind',
  'title',
  'counterparty',
  'fact',
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
] as const;

type ContextKeysOf<T> = T extends unknown ? keyof T : never;
type _MissingContextKey = Exclude<
  ContextKeysOf<YourMoveContext> | 'state' | 'text' | 'overdue',
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
}

export const YOUR_MOVE_KIND_META: Record<DashboardYourMoveCardKind, YourMoveKindMeta> = {
  calendar_reconnect: {
    label: 'Calendar',
    chip: 'calendar',
    chipLabel: 'Calendar',
    tier: 0,
    action: 'Reconnect calendar',
    tone: 'warning',
  },
  invitation: {
    label: 'Project invitation',
    chip: 'invitations',
    chipLabel: 'Invitations',
    tier: 1,
    action: 'Review invitation',
    tone: 'violet',
  },
  eoi_followup: {
    label: 'Interest sent',
    chip: 'interest',
    chipLabel: 'Interest',
    tier: 1,
    action: 'Propose times',
    tone: 'violet',
  },
  proposal_requested: {
    label: 'Proposal requested',
    chip: 'proposals',
    chipLabel: 'Proposals',
    tier: 1,
    action: 'Write proposal',
    tone: 'violet',
  },
  changes_requested: {
    label: 'Proposal changes',
    chip: 'proposals',
    chipLabel: 'Proposals',
    tier: 1,
    action: 'Revise proposal',
    tone: 'violet',
  },
  kickoff_terms: {
    label: 'Kickoff',
    chip: 'kickoff',
    chipLabel: 'Kickoff',
    tier: 1,
    action: 'Confirm terms',
    tone: 'violet',
  },
  delivery_changes: {
    label: 'Delivery changes',
    chip: 'delivery',
    chipLabel: 'Delivery',
    tier: 1,
    action: 'Open project',
    tone: 'violet',
  },
  action_items: {
    label: 'Action items',
    chip: 'action_items',
    chipLabel: 'Action items',
    tier: 2,
    action: 'View items',
    tone: 'primary',
  },
  messages: {
    label: 'Messages',
    chip: 'messages',
    chipLabel: 'Messages',
    tier: 2,
    action: 'Open messages',
    tone: 'slate',
  },
};
