import type { CaseTrailMark, CasesIndexSide } from './cases-index-view-types';

/**
 * BAL-567 — EVERY `/cases` string, in one place, each as a named constant.
 *
 * ⚠ GENDER-NEUTRAL THROUGHOUT (CLAUDE.md). Nothing here uses a gendered pronoun for a client or
 * an expert; the copy names parties, says "they", or restructures.
 *
 * ⚠ SIDE-DEPENDENT COPY IS A `Record<CasesIndexSide, …>` LOOKUP, never a `side === 'company'`
 * branch — the `UP_NEXT_COPY` shape, and what
 * `invariants/cases-index-no-view-gate.test.ts` exists to keep true.
 *
 * ⚠ MJ COPY SIGN-OFF is pending on every string here and is flagged in the PR body; it does not
 * block the build.
 *
 * PURE and client-safe: strings and small string builders only, no runtime import.
 */

// ── Page chrome ───────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ THE PAGE TITLE IS AN `<h2>`, NOT AN `<h1>` — BAL-499 shipped THE ONE `<h1>` in the top bar
 * and `nav-registry` already resolves `/cases` to it. A second `<h1>` here would be an a11y
 * defect, so the design reference's `PageHead` heading level loses (decisions D3). The LABEL
 * itself is resolved from the nav registry, never typed as a literal, so a future rename moves
 * both at once.
 */
export const CASES_INDEX_FALLBACK_TITLE = 'Cases';

export interface CasesIndexSideCopy {
  /** Names the company on the client side; the expert side never names one. */
  readonly description: (companyName: string) => string;
  readonly emptyTitle: string;
  readonly emptyBody: string;
}

/**
 * ⚠⚠ BOTH EMPTY TITLES LEAD WITH THE ACTION, AND THAT OVERRIDES THE TICKET'S LITERAL COPY.
 * The ticket specifies "No cases yet" on both sides; CLAUDE.md and `balo-ui-skill` both forbid
 * defining a section by its absence where the user can still act, and neither of these states is
 * retrospective — the client's has a CTA, and an empty expert workspace is a beginning, not a
 * record of nothing. Taking the house rule is the ruled decision (fix round X1); the CONFLICT is
 * called out explicitly in the PR's MJ sign-off list rather than either version being shipped as
 * though the two sources agreed.
 *
 * ⚠ THE CLIENT BODY LOST ITS LEADING "Book a consultation with an expert and" — with the new
 * title that clause said the same thing twice in two sentences. The substance (what a case
 * collects) is unchanged, and the CTA is untouched.
 */
export const CASES_INDEX_COPY: Readonly<Record<CasesIndexSide, CasesIndexSideCopy>> = {
  company: {
    description: (companyName: string) => `Everything ${companyName} has booked with experts.`,
    emptyTitle: 'Book your first consultation',
    emptyBody:
      'Pick an expert and a time, and your case shows up here with every call, message and file in one place.',
  },
  expert: {
    // The expert description never names a company — it is not part of its template's inputs.
    description: () => 'Everything clients have booked with you.',
    emptyTitle: 'Ready for your first client',
    emptyBody:
      'When a client books time with you, their case shows up here with every call, message and file.',
  },
};

export const CASES_INDEX_BOOK_CTA = 'Book a consultation';
export const CASES_INDEX_BOOK_HREF = '/experts';
export const CASES_INDEX_FIND_EXPERT = 'Find an expert';

export const CASES_INDEX_OPEN_SECTION = 'Open';
export const CASES_INDEX_RESOLVED_SECTION = 'Resolved';
export const CASES_INDEX_SHOW_MORE = 'Show more';
export const CASES_INDEX_SHOW_MORE_BUSY = 'Loading…';
export const CASES_INDEX_SHOW_MORE_FAILED = 'We couldn’t load more cases. Try again in a moment.';

// ── Empty, setup and lock states ──────────────────────────────────────────────────────────────

export const CASES_INDEX_SETUP_TITLE = 'Finish setup to get booked';
export const CASES_INDEX_SETUP_BODY =
  'Clients can book time with you once your expert setup is complete.';
export const CASES_INDEX_SETUP_CTA = 'Continue setup';
export const CASES_INDEX_SETUP_HREF = '/settings/expert';

/**
 * ⚠ THE LOCK STATE IS FAIL-CLOSED AND, AS OF THIS COMMIT, UNREACHABLE BY CONSTRUCTION (D9): all
 * three shipped company roles grant `PARTICIPATE`, so `resolveCompanyParticipation` cannot
 * return `member_without_participate` for a live member. It is built anyway because the loader
 * must handle every value the capability resolver can return, and because omitting it would let
 * a future non-participating role fall through to LISTING the cases.
 */
export const casesIndexLockTitle = (companyName: string): string =>
  `You can’t view ${companyName}’s cases`;
export const CASES_INDEX_LOCK_BODY =
  'Your role in this company doesn’t include cases. An owner or admin can change your role in Settings.';

export const CASES_INDEX_ERROR_TITLE = 'We couldn’t load your cases';
export const CASES_INDEX_ERROR_BODY = 'This might be a temporary issue.';
export const CASES_INDEX_RETRY = 'Try again';

// ── The featured ticket ───────────────────────────────────────────────────────────────────────

export const CASES_INDEX_FEATURED_EYEBROW = 'Your next consultation';
export const CASES_INDEX_JOIN = 'Join call';
/** Outside the window, the ticket states WHEN Join appears rather than showing a dead button. */
export const CASES_INDEX_JOIN_HINT = 'Join opens 15 min before';
export const CASES_INDEX_HAPPENING_NOW = 'Happening now';
export const casesIndexStartsIn = (minutes: number): string =>
  `Starts in ${minutes} min${minutes === 1 ? '' : 's'}`;
export const CASES_INDEX_OPEN_CASE = 'Open case';

// ── Card slots ────────────────────────────────────────────────────────────────────────────────

export const CASES_INDEX_NOTHING_BOOKED = 'Nothing booked';
export const CASES_INDEX_NO_CALLS_TITLE = 'No consultation booked';
export const CASES_INDEX_NO_CALLS_SUB = 'Pick a time to get started';
export const CASES_INDEX_BOOK_ANOTHER = 'Book another';
export const CASES_INDEX_BOOK_TIME = 'Book a time';
export const CASES_INDEX_BOOK_AGAIN = 'Book again';
export const CASES_INDEX_CHOOSE_TIME = 'Choose a time';
export const CASES_INDEX_REVIEW = 'Review';
export const CASES_INDEX_BOOKED_FOR_NOW = 'Booked for now';
export const CASES_INDEX_UNREAD = 'New';

export const casesIndexLastCall = (date: string): string => `Last call ${date}`;
export const casesIndexOpenedAt = (date: string): string => `Opened ${date}`;
export const casesIndexHeldCount = (count: number): string => `${count} held`;
export const casesIndexItemsForYou = (count: number): string => `${count} for you`;
export const casesIndexWaitingOn = (party: string): string => `Waiting on ${party}`;

/** "{Actor} suggested 3 new times" — the amber band's whole sentence. */
export const casesIndexProposalBand = (actorLabel: string, optionCount: number): string =>
  `${actorLabel} suggested ${optionCount} new time${optionCount === 1 ? '' : 's'}`;

/** "{Actor} thinks this one's sorted" — the case page's own wording, shared verbatim. */
export const casesIndexResolutionBand = (actorLabel: string): string =>
  `${actorLabel} thinks this one's sorted`;

// ── Resolved rows ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ A PREFIX, NOT A WHOLE SENTENCE, because the DATE is rendered by `LocalDateTime` — the shared
 * component that keeps a viewer-zone date from causing a hydration mismatch. Interpolating a
 * formatted date here would have forced a clock into a row that needs nothing else from one.
 *
 * ⚠ THREE OUTCOMES, NOT TWO. `case_engagements.close_reason` is NULLABLE, and a row closed
 * before that column existed must not be described as either "resolved" or "closed
 * automatically" — both would assert something nobody recorded.
 */
export const CASES_INDEX_CLOSED_PREFIX = {
  resolved: 'Resolved on',
  auto_inactive: 'Closed automatically on',
  unrecorded: 'Closed on',
} as const;

// ── The trail's accessible name ───────────────────────────────────────────────────────────────

/**
 * ⚠ THE TRAIL IS THE ONLY PURELY GRAPHICAL FACT ON THE CARD, so its `aria-label` is the whole
 * information for a screen-reader user — "Consultations: 2 held, 1 booked". `unrecorded` reads
 * as "not recorded", never "missed": the two are different events and only one accuses somebody.
 */
export const CASE_TRAIL_WORDS: Readonly<Record<CaseTrailMark, string>> = {
  held: 'held',
  booked: 'booked',
  cancelled: 'cancelled',
  missed: 'missed',
  unrecorded: 'not recorded',
};

export const casesIndexTrailLabel = (parts: readonly string[]): string =>
  `Consultations: ${parts.join(', ')}`;
