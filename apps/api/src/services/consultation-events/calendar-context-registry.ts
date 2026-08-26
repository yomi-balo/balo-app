import type {
  MeetingBookingContextType,
  MeetingContextTypeWithHolder,
} from '@balo/shared/meetings';

/**
 * BAL-433 Slice 1 (ADR-1044 amendment 2026-08-25) — WHICH BOOKABLE CONTEXT CONTRIBUTES WHAT
 * TO THE EXPERT'S CALENDAR ENTRY, as one PURE TABLE.
 *
 * ⚠ THIS MODULE HAS NO I/O AND MUST KEEP NONE. It imports no repository, no `@balo/db` and no
 * logger: it is data plus two types, so `calendar-context-registry.test.ts` can assert the
 * whole table without a database and `no-counterparty-address-on-calendar-writes.test.ts` can
 * read it as Layer-1 DATA.
 *
 * The bookable contexts that project to a calendar — which, as of BAL-433, is ALL OF THEM.
 * `isCalendarProjectedContext` is gone: there is no gate left to widen.
 */

/**
 * The five labels this registry is total over.
 *
 * ⚠ `Extract`, NOT A BARE UNION. A label renamed in the database drops out of the Extract,
 * which shrinks {@link CALENDAR_CONTEXT_REGISTRY}'s key set below `MeetingBookingContextType`
 * — and the call site that indexes it (`booking-calendar-projection.ts`, reached from
 * `provision-meeting.ts` with an `input.contextType`) then fails `pnpm --filter api typecheck`.
 * A plain union would keep the stale name and nothing would notice. Same pattern, same reason,
 * as `HandledMeetingContextType` in `@balo/shared/meetings`.
 *
 * ⚠ THE ARITIES, STATED ONCE SO NOTHING GUESSES: **7** = the `meeting_context_type` pgEnum
 * (incl. `admin`, `retainer_checkin`); **6** = `MeetingContextTypeWithHolder`; **5** =
 * `BOOKABLE_CONTEXT_TYPES` = THIS REGISTRY; **4** = `apps/web`'s engagement-authz. The two
 * excluded labels are excluded BY TYPE, never by a runtime branch: `admin` has `context_id IS
 * NULL` by CHECK and no owning party at all (unrepresentable in `MeetingContextTypeWithHolder`),
 * and `retainer_checkin` is holder-bearing but not bookable (unrepresentable in
 * `MeetingBookingContextType`).
 */
export type CalendarProjectedContextType = Extract<
  MeetingBookingContextType,
  MeetingContextTypeWithHolder
>;

/**
 * Where the SUBJECT line above the join URL comes from. A CLOSED union of the three title
 * shapes Balo actually has — deliberately data, not a callback, so the registry stays a pure
 * table and a fourth shape has to be added here on purpose.
 */
export type CalendarSubjectSource =
  /** `case_engagements.title` — the only per-case title column. */
  | 'case_title'
  /** `project_requests.title` — directly (`project_discovery`) or via the relationship hop. */
  | 'request_title'
  /**
   * ⚠ NO TITLE COLUMN EXISTS (BAL-433 D3). `engagements` has none, and neither does any
   * delivery subtype. Synthesising one from a proposal is a title CONCEPT no ticket has
   * designed, and a confidently wrong title on a calendar is worse than a neutral one — so
   * the LABEL is the subject.
   */
  | 'label';

/** The three `subjectSource` kinds, as DATA — pinned at runtime by the registry's own test. */
export const CALENDAR_SUBJECT_SOURCES = ['case_title', 'request_title', 'label'] as const;

export interface CalendarContextDescriptor {
  /**
   * The headline NOUN. ⚠ A LABEL, NOT A TITLE: a fixed string, never user input, so it needs
   * no escaping and cannot widen what a booking can write onto a calendar.
   *
   * The headline the expert sees is `` `${eventLabel} with ${clientCompanyName}` `` — ADR-1044
   * §4: prospective copy on a calendar names the client COMPANY, never a person.
   *
   * ⚠ THE SAME VOCABULARY `apps/web/…/meetings/[meetingId]/_lib/load-recap.ts`'s
   * `FALLBACK_TITLE` map uses, so a user reading their calendar and then the recap page sees
   * ONE noun set. They coincide in VALUE and diverge in PURPOSE (an api-side headline noun vs.
   * a web-side display fallback), so they are deliberately NOT hoisted into one shared
   * constant this slice — revisit if a third copy ever appears.
   */
  readonly eventLabel: string;
  readonly subjectSource: CalendarSubjectSource;
}

/**
 * ⚠⚠ THE EXHAUSTIVENESS GUARANTEE IS THE `Record`, AND IT IS COMPILE-TIME. A sixth bookable
 * label fails `pnpm --filter api typecheck` on a missing key; a label removed from
 * `BOOKABLE_CONTEXT_TYPES` fails on the stray one. `calendar-context-registry.test.ts` pairs
 * that with a runtime key-set assertion, because a key type that accidentally resolved to
 * `never` would let `{}` satisfy this Record silently.
 *
 * ⚠ DO NOT WIDEN `BOOKABLE_CONTEXT_TYPES` TO GROW THIS TABLE. That tuple is order-pinned by
 * `packages/shared/src/meetings/bookable-contexts.test.ts` and has a known `loadSubject`
 * failure mode; a new bookable label is its own decision, taken there first.
 */
export const CALENDAR_CONTEXT_REGISTRY: Record<
  CalendarProjectedContextType,
  CalendarContextDescriptor
> = {
  case: { eventLabel: 'Consultation', subjectSource: 'case_title' },
  project_kickoff: { eventLabel: 'Project kickoff', subjectSource: 'label' },
  package_session: { eventLabel: 'Package session', subjectSource: 'label' },
  project_discovery: { eventLabel: 'Discovery call', subjectSource: 'request_title' },
  request_interaction: { eventLabel: 'Intro call', subjectSource: 'request_title' },
};
