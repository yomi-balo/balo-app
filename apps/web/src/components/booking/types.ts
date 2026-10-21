import type { AvailabilityScope } from '@balo/shared/availability';
import type { EligibleCompany } from '@balo/shared/credit';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import type { BookingSource } from '@/lib/analytics';

/**
 * Client-safe mirror of `caseEngagementsRepository.listOpenForCompanyAndExpert`'s row —
 * `lastActivityAt`/`createdAt` are ISO strings, never `Date`. The shipped `load-booking-context
 * .ts` (slice 2, server-only) types these as `Date`; every view-model that crosses the
 * server→client boundary in this codebase pre-formats dates to strings first
 * (`case-view-types.ts`'s "no Date objects" rule) rather than relying on React Flight's Date
 * support, so this is a DELIBERATE re-typing, not a drift from the server type.
 */
export interface OpenCaseForExpert {
  engagementId: string;
  title: string;
  createdAt: string;
  lastActivityAt: string;
  consultationCount: number;
}

/**
 * Client-safe mirror of `BookingContext` (`lib/booking/load-booking-context.ts`), with
 * `openCases` serialized per {@link OpenCaseForExpert} and the arm-carried `expert` field
 * dropped — the wrapper's `BookingFlowExpert` prop covers that for every arm uniformly,
 * including the two failure arms `load-booking-context.ts`'s own type cannot carry it on.
 */
export type BookingContext =
  | { readonly arm: 'onboarding_required' }
  | { readonly arm: 'company_read_failed' }
  | {
      readonly arm: 'choose_company';
      readonly companies: readonly EligibleCompany[];
      /** The signed-in booker — the owner key of the on-device draft. */
      readonly viewerUserId: string;
    }
  | {
      readonly arm: 'single_company';
      /** The signed-in booker — the owner key of the on-device draft. */
      readonly viewerUserId: string;
      readonly company: EligibleCompany;
      readonly openCases: readonly OpenCaseForExpert[];
      readonly resolvedCaseCount: number;
    };

/**
 * BAL-400 — the wrapper's IDENTITY data, resolved once by whichever entry point mounts it.
 * Always present regardless of which `BookingEntry` arm is active — the header must render
 * even on the `onboarding_required` / `company_read_failed` `BookingContext` arms, and entry
 * point 3 (case quick-pick) carries no `BookingContext` at all.
 *
 * ⚠ `avatarUrl` is a RESOLVED CDN url (or `null`), never an R2 key — resolve with
 * `getAvatarUrl` at the call site, mirroring `booking-card.tsx` / the profile hero.
 */
export interface BookingFlowExpert {
  expertProfileId: string;
  name: string;
  /** `null` when the expert user has no first name on file — copy must fall back gracefully. */
  firstName: string | null;
  initials: string;
  avatarUrl: string | null;
  /** Prospective-copy PARTY label (agency name, or the independent expert's own name). */
  partyLabel: string;
  verified: boolean;
  availableForWork: boolean;
  /** Expert-search link offered when this expert is paused; absent where no vertical is known. */
  similarExpertsHref?: string;
}

/** The case entry point 3 opens from — preselected, and the only case until open cases load. */
export interface FixedCaseSummary {
  engagementId: string;
  title: string;
  consultationCount: number;
  /** ISO instant of the case's opening — the context card's "opened {relative date}" line. */
  openedAtIso: string;
}

/** A pre-selected slot, e.g. from the case-surface quick-pick (entry 3). */
export interface PresetSlot {
  startIso: string;
  endIso: string;
  durationMinutes: 15 | 30 | 45 | 60;
}

/**
 * Where the booking starts, which decides the case dropdown's default. `chooser` covers entry
 * points 1/2/4 (identical wiring — they differ only in `source` and whether an expert/slot is
 * pre-filled): the context arrives with the entry and the dropdown defaults to "Start a new
 * case". `fixed_case` is entry point 3, a booking started inside a case: that case is
 * preselected, and the dialog loads the client's other open cases itself so the dropdown can
 * switch away from it. Until they load — or if they can't be listed — the case stays fixed and
 * reads as the read-only case card.
 */
export type BookingEntry =
  | { mode: 'chooser'; context: BookingContext }
  | {
      mode: 'fixed_case';
      fixedCase: FixedCaseSummary;
      /** `null` opens on Step 1's calendar; a slot jumps straight to confirm. */
      presetSlot: PresetSlot | null;
      /**
       * `false` while the expert has paused new work: the dropdown then lists open cases only.
       * A follow-up on an open case is existing work, which a pause does not stop; a new case
       * is new work, which the server refuses (`expert_unavailable`).
       */
      newCaseAllowed: boolean;
    };

export interface BookingFlowDialogProps {
  open: boolean;
  onClose: () => void;
  expert: BookingFlowExpert;
  source: BookingSource;
  entry: BookingEntry;
  /**
   * Server-resolved viewer email domain, for the guest composer's live "same company as you"
   * disclosure ONLY — a client-side estimate for UX, never authoritative (the real
   * `access_scope` is computed server-side by `inviteGuests`, ADR-1038). `null` when unknown.
   */
  viewerEmailDomain: string | null;
  /** Invoked when the client picks "Message {Expert} instead" from the empty-availability state. */
  onMessage: () => void;
  /**
   * The Salesforce-product picker's data (design §2.4/§2.5's "Products" field). Only reachable
   * on the NEW-case path — a caller that can never offer a new case (entry point 3 with
   * `newCaseAllowed: false`) may omit it. Defaults to an empty, browsable-nothing taxonomy.
   */
  productsTaxonomy?: ProductTaxonomy;
  /**
   * Which kind of work the Step 1 slot grid is read for. Omit (`new_work`) on the profile's
   * consultation flow; the case page passes `existing_work` so a follow-up on an open case still
   * sees real slots while the expert has paused new work.
   */
  scope?: AvailabilityScope;
}
