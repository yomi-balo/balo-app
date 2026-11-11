import { UP_NEXT_ROW_VIEW_KEYS, type UpNextRowView } from './up-next-view-types';

/**
 * BAL-636 — the top-nav call pill's wire shape. CLIENT-SAFE: types and constants only. A
 * `NavCallView` is an Up next row plus one flag; it carries no money, emails or Daily room data.
 */
export interface NavCallView extends UpNextRowView {
  /**
   * `true` when the row came from the expert read while the active workspace is a client company —
   * the viewer is delivering a call that belongs to a workspace other than the one they are in.
   */
  readonly otherWorkspace: boolean;
}

export interface NavCallsResponse {
  /** ISO. The server's `now` for this response — the client's clock anchor. */
  readonly serverNowIso: string;
  /** Impersonated sessions get an empty list and no meeting reads. */
  readonly impersonating: boolean;
  readonly calls: readonly NavCallView[];
}

export const NAV_CALL_VIEW_KEYS = [
  ...UP_NEXT_ROW_VIEW_KEYS,
  'otherWorkspace',
] as const satisfies readonly (keyof NavCallView)[];
