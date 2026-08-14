import type { SessionMoneyBlock } from '@balo/shared/credit';
import type {
  RecapContextType,
  RecapResolvePromptVariant,
  RecapState,
} from '@balo/analytics/events';
import type { MeetingFileView } from './meeting-file-view-types';
import type { ActionItemsPanelView } from '@/lib/engagement/action-items-view';

/**
 * BAL-388 — the recap page's single serializable contract. PLAIN TYPES ONLY: no values, no
 * functions, no constants.
 *
 * ⚠ CLIENT-SAFE BY CONSTRUCTION. Every import above is `import type`, so all four are ERASED
 * at build and none drags `postgres` into a browser bundle (memory
 * `reference_balo_db_client_bundle_footgun`: a client component that VALUE-imports `@balo/db`
 * breaks `next build` because postgres cannot resolve `tls`). `ActionItemsPanelView` lives
 * behind a `server-only` module and is imported the same way `ActionItemsPanel` already
 * imports it — proven safe. Do NOT add a runtime import, a helper or a constant to this file.
 *
 * ⚠⚠ THE LENS IS A DISCRIMINANT, NOT A FLAG — AND THAT IS THE STRUCTURAL PROOF OF THE
 * ACCEPTANCE CRITERION that the expert lens never shows the resolve prompt. `RecapView` is a
 * UNION: the expert variant HAS NO `resolve` FIELD AT ALL. There is no optional property a
 * bug could populate, and the expert composition never references the banner or the wrap-up
 * card. The branch is at COMPOSITION, never an `if (lens === expert)` that hides copy.
 *
 * ⚠ NO EMAIL ADDRESS APPEARS IN ANY SHAPE HERE, and none is loaded on any read path that
 * feeds it (ADR-1044 counterparty concealment). Names and org labels cross the party
 * boundary; addresses never do. A `mailto:`, a gravatar-style hash, or a `title` attribute
 * carrying an address would all be the same leak.
 */

/** Re-exported so a consumer needs ONE import for the whole recap contract. */
export type { RecapContextType, RecapState, SessionMoneyBlock, MeetingFileView };
// `RecapLens` is ONLY re-exported (nothing here consumes it), so it goes out via
// `export ... from` rather than being imported first purely to be re-exported.
export type { RecapLens } from '@balo/analytics/events';

/**
 * Which shape the resolve prompt takes. `requested` ⇒ R4 banner; `offered` ⇒ R9 rail card.
 *
 * ⚠⚠ AN ALIAS OF THE ANALYTICS TYPE, NOT A SECOND DECLARATION. `page.tsx` feeds this
 * value straight into `recap_viewed.resolve_prompt_variant`; two identical three-member unions
 * under two names would have nothing pinning them equal, so the alias IS the pin.
 */
export type RecapResolveVariant = RecapResolvePromptVariant;

/** Which of the four artefact renders a section is in (§R5 / §R7). */
export type RecapArtifactState = 'processing' | 'ready' | 'absent' | 'failed';

export interface RecapArtifactView {
  state: RecapArtifactState;
  /**
   * The artefact body, or `null`. ⚠ AN EMPTY STRING IS NORMALISED TO THE `absent` STATE
   * UPSTREAM and never arrives here as `ready` with an empty body: an empty card reads as a
   * bug rather than as an absence.
   */
  content: string | null;
}

export interface RecapArtifactsView {
  summary: RecapArtifactView;
  transcript: RecapArtifactView;
  /**
   * TRUE when summary AND transcript are BOTH non-`ready`, in which case the page renders ONE
   * collapsed card instead of two sad stacked ones. A deliberate composition rule.
   */
  collapsed: boolean;
}

/**
 * Rule M — the money line, keyed on the PRESENCE of a `credit_sessions` row and never on a
 * duration or a policy.
 *
 *   · `absent`  (M1) — no row. ONE muted line, no figure, no explanation. It stays true by
 *                      construction when BAL-412 makes a no-show billable: a row appears, this
 *                      arm simply stops matching, and no copy changes.
 *   · `session` (M2/M3) — a row exists. The SHIPPED `MoneyBlock` fragment renders its own
 *                      pending / finalized / loading / error states. `block: null` is the
 *                      fragment's OWN muted fallback — never a second error state around it.
 */
export type RecapMoneyView =
  | { kind: 'absent' }
  | { kind: 'session'; block: SessionMoneyBlock | null; elapsedMinutes: number };

/** Chip tone — the shipped semantic tokens, no hardcoded colour. */
export type RecapStatusTone = 'success' | 'warning' | 'neutral';

export interface RecapStatusView {
  label: string;
  tone: RecapStatusTone;
  /** Icon NAME; the client component maps it. Keeps this module value-free. */
  icon: 'check' | 'clock' | 'ban' | 'circle-check';
}

export interface RecapHeaderView {
  /**
   * §R1 context label. It USED to stand in for a breadcrumb "the case surface would have
   * given us" — BAL-421 built that surface, so on a `case` recap the eyebrow now sits beside
   * a real {@link RecapHeaderView.caseHref} back link rather than substituting for one. It is
   * still the only identification a NON-case context gets.
   */
  eyebrow: string;
  /**
   * `/cases/{engagementId}` on a `case` recap; `null` on every other context.
   *
   * ⚠ NO `?from=recap` QUERY PARAM, DELIBERATELY — and the asymmetry with the case→recap
   * direction (which DOES carry `?from=case_surface`) is intentional, not an oversight. The full
   * rationale lives at the emitting site in `load-recap.ts`: nothing reads a `from` param on
   * `/cases/{id}`, so appending one would be an unread query string that LOOKS like
   * instrumentation. Read that note before adding it.
   *
   * ⚠ `null` ⇒ NO LINK RENDERS, never a disabled one. Only the `case` context's `contextId`
   * IS an `engagements.id` that `/cases/[engagementId]` can resolve; the other three
   * engagement-grain contexts have no surface at all, and the two request-grain ones are not
   * engagements. Computed in `load-recap.ts` — this module is PLAIN TYPES ONLY.
   */
  caseHref: string | null;
  title: string;
  status: RecapStatusView;
  /** §R1 closed-case note, or `null` while the case is open / on a non-case context. */
  closedNote: string | null;
  /** When it happened: `started_at` if known, else `scheduled_start`. ISO instant. */
  occurredAtIso: string;
  /** `ended_at − started_at` in whole minutes; `null` when either stamp is missing. */
  durationMinutes: number | null;
  openActionItemCount: number;
  totalActionItemCount: number;
}

export interface RecapPartyView {
  /** The counterparty's name. NEVER an email address. */
  name: string;
  /** `expert_profiles.headline` on the client lens; `null` on the expert lens. */
  headline: string | null;
  /** Agency (client lens) or company (expert lens) name; `null` when there is none. */
  orgLabel: string | null;
  avatarUrl: string | null;
  initials: string;
  /** The ordinal line, e.g. 3rd consultation on this case. `null` when not derivable. */
  ordinalLine: string | null;
  /**
   * `/experts/{username}` — the ONE forward action with a live destination today, and ONLY
   * when `expert_profiles.username` is non-null (the column is NULLABLE). `null` ⇒ the card
   * renders no action at all. NEVER a disabled CTA, and never a link to `/experts/null`.
   */
  bookAgainHref: string | null;
  /**
   * The delivering expert's average rating (BAL-422), or `null`.
   *
   * ⚠⚠ CLIENT LENS ONLY. `resolve-counterparty.ts` populates it on the `client` branch and
   * hardcodes `null` / `0` on the `expert` branch, whose counterparty is the client COMPANY —
   * nothing evaluative appears there, because the expert is not scoring the client.
   *
   * ⚠ `null` MEANS NO REVIEWS, NEVER 0.0. `PartyCard` gates the line on THIS field.
   *
   * ⚠ THE SHARED RESOLVER POPULATES THIS FOR THE END-OF-CALL LOADER TOO, BUT NOTHING RENDERS
   * IT THERE — AND IT IS DELIBERATELY NOT GATED OFF. `resolve-counterparty.ts` was hoisted out
   * of `load-recap.ts` (BAL-389) so the recap and the end-of-call screen name the counterparty
   * identically, so `load-end-of-call.ts` does call it — but it consumes ONLY
   * `expertShortName` / `agencyLabel` and never reads `party` at all (verified, and stated in
   * its own comment at the `resolveCounterparty` call). The rating is therefore computed and
   * discarded on that path today. It is left ungated on purpose: if that screen ever adopts
   * the party card it should inherit the same client-lens rating with no change here.
   */
  ratingAverage: number | null;
  /** ENGAGEMENTS REVIEWED, not review rows. Rendered WHENEVER `ratingAverage` is. */
  ratingCount: number;
}

export interface RecapFileRowView {
  /** ⚠ `r2Key` IS STRUCTURALLY ABSENT — `MeetingFileView` omits it. Keep it that way. */
  file: MeetingFileView;
  /** You, for the viewer's own uploads; otherwise the uploader's FIRST NAME. Never an email. */
  uploaderLabel: string;
}

export type RecapNotHeldReason = 'no_show_client' | 'missed_call' | 'cancelled';

export interface RecapNotHeldView {
  reason: RecapNotHeldReason;
  /** ONE shared headline across all four cells — the meeting is the subject, not a person. */
  headline: string;
  /** Who was where. Client-side absence names the PARTY; expert-side names the person. */
  body: string;
}

/**
 * The post-resolve SUCCESS state — present once the case is CLOSED, absent while it is open.
 */
export interface RecapResolvedView {
  /**
   * TRUE when closing this case actually put a review link in the client inbox. FALSE for an
   * `auto_inactive` close (no token is minted) and for a reviewer who had already rated this
   * expert on this engagement (`resolveReviewAsk` skips the mint). The success copy is keyed on
   * it so the page never confirms an email that was never sent.
   */
  reviewLinkSent: boolean;
}

export interface RecapResolveView {
  /** The case engagement id — the subject of both mutations. */
  engagementId: string;
  variant: RecapResolveVariant;
  /**
   * Retrospective attribution for the banner headline — a person @ agency on first mention,
   * bare person for an independent expert. `null` when no request is pending.
   */
  requesterLabel: string | null;
  /** The bare person/party name the dialog copy uses when offering a future case. */
  expertShortName: string;
  /**
   * Non-null once the case is CLOSED — the IN-PLACE §R9 success state. The wrap-up card keeps
   * its rail slot and states the outcome rather than unmounting, so the one irreversible action
   * on the page is confirmed where it was taken and the rail does not jump.
   */
  resolved: RecapResolvedView | null;
  /**
   * TRUE when closing this case WOULD send a review link — i.e. this reviewer has not already
   * rated this expert on this engagement. Drives the dialog fourth fact.
   */
  reviewWillBeAsked: boolean;
}

interface RecapViewBase {
  meetingId: string;
  contextType: RecapContextType;
  state: RecapState;
  header: RecapHeaderView;
  /** `null` for every NON-`case` context — there is no per-meeting money on those. */
  money: RecapMoneyView | null;
  artifacts: RecapArtifactsView;
  /** `null` when the meeting has no engagement-grain anchor for the panel. */
  actionItems: ActionItemsPanelView | null;
  party: RecapPartyView;
  files: RecapFileRowView[];
  /** Present ⇒ R11 REPLACES summary / action items / transcript. */
  notHeld: RecapNotHeldView | null;
}

/**
 * The page's payload. ⚠ THE EXPERT ARM CARRIES NO `resolve` FIELD — see the module docblock.
 */
export type RecapView =
  | (RecapViewBase & { lens: 'client'; resolve: RecapResolveView })
  | (RecapViewBase & { lens: 'expert' });
