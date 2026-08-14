import type { GuestForViewer } from '@balo/shared/meetings';
import type {
  MeetingPanelInviteOutcome,
  MeetingPanelDecisionOutcome,
} from '@balo/analytics/client';
import type { MeetingFileView } from './meeting-file-view-types';

/**
 * BAL-436 — the SIDE PANEL's registration contract. TYPES ONLY: no values, no functions, no
 * constants, no React.
 *
 * ⚠⚠ IT CARRIES **CALLBACKS, NOT DATA**. Panel state lives in the panel; this is the
 * capability plus its Server Actions. Two consequences, both deliberate:
 *   1. `MeetingCallSurface`'s prop contract stays FROZEN — BAL-435's seam docblock states the
 *      rule ("a prop added later is a contract change; a prop added here is the contract"),
 *      so the panel extends the route CONTEXT instead.
 *   2. Every panel component is testable with plain fakes — no `next/headers` mock, no Server
 *      Action machinery, no api double.
 *
 * ⚠ THE `meetingId` IS **NOT** ON THIS INTERFACE. The registration closes over it in
 * `call-client.tsx`, so no panel component ever handles a meeting id it could send to the
 * wrong action.
 *
 * ⚠ CLIENT-SAFE. Every import above is `import type` and every module it reaches is pure, so
 * nothing here can drag `@balo/db` (and therefore `postgres`) into a browser graph — the
 * `next build` "can't resolve 'tls'" footgun, which no local gate catches.
 */

/**
 * The registered slots. ⚠ `'chat'` IS BAL-437'S AND IS DELIBERATELY NOT DECLARED HERE — a
 * union member with no panel behind it is an openable slot that renders nothing.
 */
export type MeetingPanelId = 'people' | 'files';

/** The guests GET payload, exactly as the api returns it. */
export interface MeetingGuestsPayload {
  readonly guests: readonly GuestForViewer[];
  /**
   * ⚠⚠ THE SERVER'S PER-ACTOR `hasEngagementCapability(HOST_MEETINGS)` VERDICT for this exact
   * meeting, computed behind the tenancy gate that must run first.
   *
   * **DO NOT CALL THE WEB ENGAGEMENT RESOLVER TO RE-DERIVE IT, EVEN THOUGH ONE NOW EXISTS**
   * (`apps/web/src/lib/authz/engagement.ts`, opened by BAL-421). A second resolution in the
   * browser tier would be a second expression of one rule, and it would run WITHOUT
   * `authorizeMeetingParticipation` in front of it. `meeting-call-no-lens-gate.test.ts`
   * enforces this mechanically for the whole call subtree.
   */
  readonly canHost: boolean;
  /**
   * ⚠⚠ A **SEAT** COUNT — the reserved pair plus pre-admitted and admitted guests, from the
   * very counter the server refuses invites on. It is NOT the tile count and the two
   * routinely differ. Render "{n} of {cap}" from this pair, never from a local count.
   */
  readonly participantCount: number;
  readonly participantCap: number;
}

/**
 * ⚠ `retryable` DISTINGUISHES A TRANSPORT BLIP FROM A VERDICT. The poll keeps its schedule on
 * a retryable failure and stops on a terminal one — collapsing the two is what makes a
 * dropped packet look like a dead meeting.
 */
export type GetMeetingGuestsResult =
  | { readonly success: true; readonly data: MeetingGuestsPayload }
  | { readonly success: false; readonly error: string; readonly retryable: boolean };

/**
 * ⚠ `outcome` IS THE ANALYTICS DIMENSION, CARRIED BACK RATHER THAN RE-DERIVED FROM THE COPY.
 * Branching a PostHog property on a user-facing string would mean every copy edit silently
 * re-buckets a dashboard.
 */
export type InviteMeetingGuestsResult =
  | {
      readonly success: true;
      readonly invitedCount: number;
      readonly participantCount: number;
      readonly participantCap: number;
    }
  | {
      readonly success: false;
      readonly error: string;
      readonly outcome: Exclude<MeetingPanelInviteOutcome, 'ok'>;
    };

/**
 * ⚠⚠ `already_decided` IS NOT A FAILURE — it is the two-hosts race answer (`409
 * guest_not_pending`). The panel renders it as an INFORMATIONAL toast plus a refetch, never
 * as an error: the outcome the host wanted has happened, just not by their click.
 */
export type DecideAdmissionActionResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly error: string;
      readonly outcome: Exclude<MeetingPanelDecisionOutcome, 'ok'>;
    };

export type ResendLinkActionResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: string };

/** BAL-423's shipped file actions, re-stated as the shape the panel is handed. */
export type ListMeetingFilesActionResult =
  | { readonly success: true; readonly files: MeetingFileView[] }
  | { readonly success: false; readonly error: string };

export type RequestUploadActionResult =
  | { readonly success: true; readonly presignedUrl: string; readonly key: string }
  | { readonly success: false; readonly error: string };

export type ConfirmUploadActionResult =
  | { readonly success: true; readonly file: MeetingFileView }
  | { readonly success: false; readonly error: string };

export type DownloadFileActionResult =
  | { readonly success: true; readonly url: string }
  | { readonly success: false; readonly error: string };

/** The Files half of the registration, grouped so the People half reads cleanly. */
export interface MeetingFilePanelActions {
  readonly list: () => Promise<ListMeetingFilesActionResult>;
  readonly requestUpload: (input: {
    contentType: string;
    fileName: string;
    sizeBytes: number;
  }) => Promise<RequestUploadActionResult>;
  readonly confirmUpload: (input: {
    key: string;
    fileName: string;
    sizeBytes: number;
  }) => Promise<ConfirmUploadActionResult>;
  readonly download: (fileId: string) => Promise<DownloadFileActionResult>;
}

export interface MeetingPanelRegistration {
  /**
   * ⚠⚠ THE BARE, **TOKENLESS** JOIN URL — `${APP_URL}/join/m/{meetingId}`. Built server-side.
   *
   * The raw guest token never comes back from the api and the UI never builds a link
   * (`guests.ts` contract point 4). Anyone opening this lands in the pending lobby and must
   * be admitted, which is exactly what the button's helper line says.
   */
  readonly joinLinkUrl: string;
  readonly loadGuests: () => Promise<GetMeetingGuestsResult>;
  readonly inviteGuests: (emails: readonly string[]) => Promise<InviteMeetingGuestsResult>;
  readonly decideAdmission: (
    guestId: string,
    decision: 'admit' | 'deny'
  ) => Promise<DecideAdmissionActionResult>;
  readonly resendLink: (guestId: string) => Promise<ResendLinkActionResult>;
  readonly files: MeetingFilePanelActions;
}
