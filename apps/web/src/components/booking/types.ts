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
  | { readonly arm: 'choose_company'; readonly companies: readonly EligibleCompany[] }
  | {
      readonly arm: 'single_company';
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
}

/** The case entry point 3 (D4a #3) fixes — no chooser, no company resolution. */
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
 * The one axis that actually changes the wrapper's shape (D4a): whether the case-choice
 * section exists at all. `chooser` covers entry points 1/2/4 (identical wiring — they differ
 * only in `source` and whether an expert/slot is pre-filled); `fixed_case` is entry point 3,
 * where the case-choice section is ABSENT FROM THE TREE, not defaulted or collapsed.
 */
export type BookingEntry =
  | { mode: 'chooser'; context: BookingContext }
  | { mode: 'fixed_case'; fixedCase: FixedCaseSummary; presetSlot: PresetSlot };

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
   * on the NEW-case path, which entry point 3 (`fixed_case`) never renders — callers that never
   * reach the chooser (the case surface) may omit it. Defaults to an empty, browsable-nothing
   * taxonomy.
   */
  productsTaxonomy?: ProductTaxonomy;
}
