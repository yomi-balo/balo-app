import type { MeetingLifecycleStatus } from '@balo/shared/meetings';
import type { DashboardUpNextMeetingType } from '@balo/analytics/events';

/**
 * BAL-566 — the Up next card's client-safe view model. This module is CLIENT-SAFE: types and
 * constants only, imported by both server-only builders (`build-up-next-rows.ts`) and client
 * components (`up-next-card.tsx`, `up-next-row.tsx`).
 */

/** `'case' | 'project_kickoff' | 'project_discovery' | 'request_interaction'`. */
export type UpNextMeetingType = DashboardUpNextMeetingType;
/** = `NavWorkspaceType`. */
export type UpNextWorkspaceType = 'company' | 'expert';

/**
 * ONE row, crossing the RSC→client boundary. NO money, rates, fees, emails, Daily room names or
 * Daily join URLs — pinned by the key-set test in `build-up-next-rows.test.ts`.
 */
export interface UpNextRowView {
  readonly meetingId: string;
  readonly contextType: UpNextMeetingType;
  /** `null` when the owning row is unverified (expert side) — never another tenant's title. */
  readonly title: string | null;
  /**
   * Client side: the expert person, or 'Balo' for a match-routed discovery call. Expert side: the
   * client company. `null` = unverified.
   */
  readonly counterpartyName: string | null;
  /** Client side: the expert's agency; otherwise `null`. */
  readonly counterpartyOrgLabel: string | null;
  /** ISO. */
  readonly scheduledStart: string;
  /** ISO. */
  readonly scheduledEnd: string;
  readonly status: MeetingLifecycleStatus;
  /** `hrefForMeeting` — `null` renders an un-linked row. */
  readonly href: string | null;
  /**
   * `memberCallPath(meetingId)` — the AUTHENTICATED MEMBER call route (`/meetings/{id}/call`,
   * BAL-435), built server-side (BAL-566 fix round 1, F1 / user ruling J1). NOT `memberJoinPath`
   * (the anonymous guest lobby) — see `member-call-path.ts` for why. Navigated to via
   * `location.assign`, NEVER bound to an href (D9).
   */
  readonly joinPath: string;
  /** Case rows only: the live pending proposal's `expiresAt` (ISO). Liveness re-derived on the tick. */
  readonly rescheduleProposalExpiresAt: string | null;
}

export const UP_NEXT_ROW_VIEW_KEYS = [
  'meetingId',
  'contextType',
  'title',
  'counterpartyName',
  'counterpartyOrgLabel',
  'scheduledStart',
  'scheduledEnd',
  'status',
  'href',
  'joinPath',
  'rescheduleProposalExpiresAt',
] as const satisfies readonly (keyof UpNextRowView)[];

/**
 * BAL-566 fix round 1 (F15) — compile-time reverse check, made REAL: a key added to
 * `UpNextRowView` but not to `UP_NEXT_ROW_VIEW_KEYS` makes `_MissingKey` non-`never`, and the
 * literal `true` below then fails to `satisfy` the resulting `never` type — a genuine tsc error,
 * not merely a claim in a comment (the previous `AssertUpNextKeysComplete` type alias was never
 * referenced anywhere, so nothing ever forced TypeScript to evaluate whether it held). Exported
 * and referenced by `up-next-view-types.test.ts` so it can't rot back into "declared but unused".
 */
type _MissingKey = Exclude<keyof UpNextRowView, (typeof UP_NEXT_ROW_VIEW_KEYS)[number]>;
export const ASSERT_UP_NEXT_KEYS_COMPLETE = true satisfies _MissingKey extends never ? true : never;

export type UpNextData =
  | { readonly kind: 'ready'; readonly rows: readonly UpNextRowView[] } // rows may be [] → Empty state
  | { readonly kind: 'error' };

export interface UpNextFooterLink {
  readonly target: 'cases' | 'projects' | 'calendar';
  readonly label: string;
  readonly href: string;
}
