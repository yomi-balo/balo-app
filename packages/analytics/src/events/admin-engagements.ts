export const ADMIN_ENGAGEMENTS_EVENTS = {
  LIST_VIEWED: 'admin_engagements_list_viewed',
} as const;

/** Status filter applied to the admin engagements oversight list. */
export type AdminEngagementsFilter =
  | 'in_flight'
  | 'active'
  | 'in_review'
  | 'stalled'
  | 'completed'
  | 'cancelled';

export interface AdminEngagementsEventMap {
  [ADMIN_ENGAGEMENTS_EVENTS.LIST_VIEWED]: {
    filter: AdminEngagementsFilter;
    count_active: number;
    count_in_review: number;
    count_stalled: number;
  };
}
