/**
 * BAL-492 — the guest recap INDEX's single serializable contract. PLAIN TYPES ONLY: no values,
 * no functions, no constants, no imports at all — even `import type` — the exact discipline
 * `guest-recap-view-types.ts` states for the per-meeting view.
 *
 * ⚠⚠ EXACTLY THREE DISCLOSED PRIMITIVES PER ROW, PLUS THE ID THE LINK NEEDS. There is no
 * `title`, no `counterparty`, no `roster`, no `summaryState`, no `status`, no `filesCount`.
 * The absence is structural: there is no optional property a bug could populate.
 *
 * ⚠ NO `Meeting` ROW CROSSES. A `Meeting` carries `dailyRoomName` and `joinUrl`, which never
 * leave the loader.
 */
export interface GuestRecapIndexRowView {
  /** The GATE'S `access.meeting.id`, never the reverse read's row and never a parsed input. */
  readonly meetingId: string;
  /** The GENERIC context label ("Consultation", "Intro call"), never a case title. */
  readonly contextLabel: string;
  /** `started_at` if known, else `scheduled_start`. ISO 8601 instant. */
  readonly occurredAtIso: string;
  /** Whole minutes, or `null`. NEVER a placeholder. */
  readonly durationMinutes: number | null;
}
