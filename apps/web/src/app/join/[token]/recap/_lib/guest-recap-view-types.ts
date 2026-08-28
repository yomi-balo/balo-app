/**
 * BAL-439 — the guest recap page's SINGLE serializable contract. PLAIN TYPES ONLY: no values,
 * no functions, no constants, no imports at all — even `import type` — so this module can never
 * become a place a future edit smuggles a helper or a runtime dependency into.
 *
 * ⚠⚠ THE NAMED FAIL-CLOSED SEAM IS THE ABSENCE OF FIELDS. There is no `recordings`, no `money`,
 * no `party`, no `actionItems`, no `transcript`, no `resolve`, no `state`, no `files`, no
 * `guestId`, no `accessScope`, and no email of anybody. This is the same structural device the
 * member `RecapView`'s expert arm uses for `resolve` (`recap-view-types.ts`): there is no
 * optional property a bug could populate. `load-guest-recap.test.ts` pins the exact key set, so
 * widening the payload requires editing a guard.
 *
 * ⚠ `files` IS DELIBERATELY ABSENT. The Files card fetches through the shipped guest Server
 * Actions client-side (`guest-recap-files.tsx`), so no file row ever crosses THIS RSC boundary,
 * and the loader reaches `meetingFilesRepository` not at all.
 *
 * ⚠ NO `Meeting` ROW CROSSES TO THE CLIENT. `GuestRecapHeaderView` is narrowed to three
 * primitives; a `Meeting` row carries `dailyRoomName` and `joinUrl`, which never leave the
 * loader (`load-recap.ts`'s own rule, applied here).
 *
 * ⚠ THIS IS A SIBLING OF THE MEMBER `RecapView`, NEVER A FOURTH `RecapLens` VALUE (R5). It has
 * no `lens` field at all — a guest is not a lens, it is a different reader on a different route.
 */

/** Which of the four states the guest's summary card renders. */
export type GuestRecapArtifactState = 'processing' | 'ready' | 'absent' | 'failed';

export interface GuestRecapSummaryView {
  readonly state: GuestRecapArtifactState;
  /**
   * The artefact body, or `null`. ⚠ AN EMPTY STRING IS NORMALISED TO THE `absent` STATE
   * upstream and never arrives here as `ready` with an empty body — the same rule the member
   * recap's `RecapArtifactView` states: an empty card reads as a bug.
   */
  readonly content: string | null;
}

export interface GuestRecapHeaderView {
  /** The GENERIC context label ("Consultation", "Discovery call"), never a case title. */
  readonly contextLabel: string;
  /** `started_at` if known, else `scheduled_start`. ISO 8601 instant. */
  readonly occurredAtIso: string;
  /** Whole minutes, or `null`. NEVER a placeholder — `durationMinutesOf`'s own rule. */
  readonly durationMinutes: number | null;
}

export interface GuestRecapView {
  readonly meetingId: string;
  readonly header: GuestRecapHeaderView;
  readonly summary: GuestRecapSummaryView;
  /** FALSE ⇒ an engagement-scope retrospective read. Drives one honest line of copy. */
  readonly isOwnMeeting: boolean;
}
