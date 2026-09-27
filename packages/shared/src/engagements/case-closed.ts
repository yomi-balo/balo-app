import type { MeetingLifecycleStatus } from '../meetings';
import type { EngagementCaseClosedPayload } from '../notifications';
import { expertPartyDisplayName, type ExpertPartyType } from '../parties';
import { formatLongUtc } from '../timezone/utc-date';

/**
 * BAL-572 — the case-close notification payload assembly, EXTRACTED from
 * `apps/web/src/lib/cases/close-case-effects.ts` so the api's inactivity sweep (the second
 * publisher of `engagement.case_closed`) can build the exact same payload shape the web
 * publisher does, without either app importing the other.
 *
 * PURE and dependency-free — no `@balo/db`, no I/O, no clock of its own. Every input is either
 * a primitive or the RAW result of a read the caller already performed; this module owns only
 * the ASSEMBLY (the fallback strings, the party label, the title cap, the date format, the
 * correlation id), never the reads themselves. Each app keeps its own two-wave `Promise.all`.
 *
 * ⚠ BEHAVIOUR IS PORTED, NOT REINVENTED. `capCaseTitle`, `summariseCaseCloseAnchors` and
 * `buildCaseClosedPayload` mirror `close-case-effects.ts`'s `capCaseTitle`, `heldCountOf` /
 * `mostRecentHeldIdOf` and `publishCaseClosed`'s assembly line for line. `close-case-effects.ts`
 * re-points at these exports; `close-case-effects.test.ts` and both `resolve-case.test.ts` pass
 * unchanged, which is the proof the port changed nothing.
 */

/**
 * `case_title` is an UNCAPPED `text` column, but the publish schema caps it at 200 and
 * `publishNotificationEvent` SWALLOWS a 400 — so a long title would silently mean no close
 * email at all. Truncating here is the difference between a slightly shortened subject line
 * and a missing email.
 */
export const CASE_TITLE_MAX = 200;

export function capCaseTitle(title: string): string {
  if (title.length <= CASE_TITLE_MAX) return title;
  return title.slice(0, CASE_TITLE_MAX - 1) + '…';
}

/**
 * Exactly what the anchor derivation reads from a consultation sibling — STRUCTURAL, never
 * `@balo/db`'s `Meeting` row. A full `Meeting` row (which carries `dailyRoomName` and
 * `joinUrl`) is assignable to this type, so a caller can pass one straight through without a
 * mapping step, but nothing wider than these five fields is ever read.
 */
export interface CaseCloseAnchorMeeting {
  id: string;
  scheduledStart: Date;
  startedAt: Date | null;
  status: MeetingLifecycleStatus;
  outcome: string | null;
}

/** Both figures a case-close notice needs, derived from one already-read sibling set. */
export interface CaseCloseAnchors {
  heldCount: number;
  /** `undefined` ⇒ the templates render NO deep link. See {@link summariseCaseCloseAnchors}. */
  anchorMeetingId: string | undefined;
}

/**
 * How many of a case's consultations were actually HELD, and which one was the MOST RECENT —
 * PURE, over an already-read sibling set. Ported from `heldCountOf` / `mostRecentHeldIdOf`
 * (`close-case-effects.ts`), unified into one pass over the same input.
 *
 * ⚠ "HELD" MEANS `status === 'ended' && outcome === 'completed'` — never a cancelled or
 * no-show slot. A cancelled meeting was never a consultation; a no-show `ended` but the call
 * did not happen, so neither counts.
 *
 * ⚠ THE ANCHOR IS DELIBERATELY "MOST RECENT HELD", NOT "MOST RECENT". A case closed before any
 * consultation was held correctly returns `anchorMeetingId: undefined` rather than pointing at
 * a cancelled or no-show meeting, whose recap would say the call never happened — a worse CTA
 * than none. NEVER fabricate an id.
 *
 * Ordering is `COALESCE(startedAt, scheduledStart) ASC`, tie-broken on `id` so the answer is
 * stable across refreshes; the LAST entry in that order is the most recent.
 */
export function summariseCaseCloseAnchors(
  siblings: readonly CaseCloseAnchorMeeting[]
): CaseCloseAnchors {
  const held = siblings.filter(
    (meeting) => meeting.status === 'ended' && meeting.outcome === 'completed'
  );
  const ordered = held.slice().sort((a, b) => {
    const delta =
      (a.startedAt ?? a.scheduledStart).getTime() - (b.startedAt ?? b.scheduledStart).getTime();
    return delta === 0 ? a.id.localeCompare(b.id) : delta;
  });
  return { heldCount: held.length, anchorMeetingId: ordered.at(-1)?.id };
}

/**
 * The RAW read results `buildCaseClosedPayload` assembles into `EngagementCaseClosedPayload`.
 * Every field here is exactly what a caller's own `Promise.all` reads have on hand — no
 * fallback has been applied yet, and `caseTitle` is UNCAPPED.
 */
export interface BuildCaseClosedPayloadInput {
  engagementId: string;
  /** OPTIONAL — the CTA subject on both channels. Absent ⇒ the templates render no link. */
  meetingId: string | undefined;
  /** Client-side reviewer id. Absent ⇒ the client rule skips (the expert arm is unaffected). */
  recipientId: string | undefined;
  expertProfileId: string;
  /** Raw `companiesRepository.findNameById(...)?.name`. */
  companyName: string | undefined;
  /** Raw `expertsRepository.findDisplayProfileById(...)?.type`. */
  expertProfileType: ExpertPartyType | undefined;
  /** Raw `agenciesRepository.getSummaryById(...)?.name`. */
  agencyName: string | null | undefined;
  /** Raw `usersRepository.findDisplayById(...)?.firstName`. */
  expertFirstName: string | null | undefined;
  /** Raw `usersRepository.findDisplayById(...)?.lastName`. */
  expertLastName: string | null | undefined;
  /** UNCAPPED — `buildCaseClosedPayload` applies {@link capCaseTitle}. */
  caseTitle: string;
  closedAt: Date;
  closeReason: EngagementCaseClosedPayload['closeReason'];
  consultationCount: number | undefined;
  reviewToken: string | undefined;
}

/**
 * Assemble `EngagementCaseClosedPayload` — the ONE definition of the fallback strings, the
 * party label, the title cap and the date format, shared by web's client-close publisher and
 * the api's inactivity sweep. Neither app is allowed to re-spell these rules; only the raw
 * reads differ between them.
 *
 * ⚠ `correlationId` IS `${engagementId}:case_closed` — the BullMQ jobId dedup key. There is
 * only ever one close per case, so this stays a fixed, non-parameterised suffix.
 */
export function buildCaseClosedPayload(
  input: BuildCaseClosedPayloadInput
): EngagementCaseClosedPayload {
  return {
    correlationId: input.engagementId + ':case_closed',
    engagementId: input.engagementId,
    meetingId: input.meetingId,
    recipientId: input.recipientId,
    expertProfileId: input.expertProfileId,
    clientCompanyName: input.companyName ?? 'your company',
    expertPartyLabel: expertPartyDisplayName({
      type: input.expertProfileType ?? 'freelancer',
      agencyName: input.agencyName ?? null,
      firstName: input.expertFirstName ?? null,
      lastName: input.expertLastName ?? null,
    }),
    caseTitle: capCaseTitle(input.caseTitle),
    closedDate: formatLongUtc(input.closedAt),
    closeReason: input.closeReason,
    consultationCount: input.consultationCount,
    reviewToken: input.reviewToken,
  };
}
