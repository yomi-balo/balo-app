/**
 * experts/application-edit — BAL-593's shared contract for a Balo-staff edit of an expert
 * application: the editable-status vocabulary, the four edit SECTIONS (used by the planner, the
 * post-approval email and analytics alike), and the delta shape the Server Action sends.
 *
 * PURE. No I/O, no clock, no `@balo/db` — the same reason `application-decision.ts` restates the
 * decline vocabulary here rather than importing the pgEnum: a client island (the edit form) may
 * not value-import `@balo/db`.
 *
 * ⚠ NO `.js` EXTENSIONS ON RELATIVE IMPORTS IN `packages/shared`. EVER.
 */

/**
 * The three `application_status` values a staff edit may act on. `draft` and `rejected` are
 * excluded by construction — a draft is the applicant's own unsubmitted work, and a declined
 * application stays read-only (AC 7). `approved` is included: an approved application is live and
 * editable, and editing it is what triggers the post-approval email (H3/H5).
 */
export const STAFF_EDITABLE_APPLICATION_STATUSES = [
  'submitted',
  'under_review',
  'approved',
] as const;

/** @see STAFF_EDITABLE_APPLICATION_STATUSES */
export type StaffEditableApplicationStatus = (typeof STAFF_EDITABLE_APPLICATION_STATUSES)[number];

/**
 * The four sections a staff edit groups its changes into — shared by the delta planner, the
 * post-approval email body and the `admin_applications_edited` analytics property. ORDER is the
 * display order on every surface that lists them.
 *
 * Section mapping (the planner's one definition of what falls where):
 * - `experience` — the experience scalars (`yearStartedSalesforce`, `projectCountMin`,
 *   `projectLeadCountMin`, the three MVP/CTA/trainer flags), plus languages and industries.
 * - `products` — products added or removed.
 * - `ratings` — ratings changed on a RETAINED product (a product that was also added or removed
 *   is reported under `products`, never double-counted into `ratings` too).
 * - `certifications` — certifications added or removed.
 */
export const EXPERT_APPLICATION_EDIT_SECTIONS = [
  'ratings',
  'products',
  'certifications',
  'experience',
] as const;

/** @see EXPERT_APPLICATION_EDIT_SECTIONS */
export type ExpertApplicationEditSection = (typeof EXPERT_APPLICATION_EDIT_SECTIONS)[number];

/**
 * A staff-authored edit to an expert application: a DELTA, never a full replacement. Every key is
 * optional; the caller must set at least one (an edit with none is `no_changes` — H3). Sub-shapes
 * are either a per-field `Partial` (only the fields that changed) or a FULL set (languages,
 * industries, retained-product ratings) — a full set is simpler to diff against the locked
 * snapshot than a second delta-of-a-delta.
 */
export interface StaffApplicationEdit {
  /** Changed experience scalars only — at least one key when present. */
  experience?: Partial<{
    yearStartedSalesforce: number;
    projectCountMin: number;
    projectLeadCountMin: number;
    isSalesforceMvp: boolean;
    isSalesforceCta: boolean;
    isCertifiedTrainer: boolean;
  }>;
  /** The FULL set of languages, when changed. */
  languages?: {
    languageId: string;
    proficiency: 'beginner' | 'intermediate' | 'advanced' | 'native';
  }[];
  /** The FULL set of industry ids, when changed. */
  industryIds?: string[];
  /** Products newly added, each with its full rating set. */
  productsAdded?: {
    productId: string;
    ratings: { supportTypeId: string; proficiency: number }[];
  }[];
  /** Product ids removed. */
  productsRemoved?: string[];
  /** Ratings changed on RETAINED products only — a product also in `productsAdded` /
   *  `productsRemoved` is never represented here too. */
  ratings?: { productId: string; supportTypeId: string; proficiency: number }[];
  /** Certification ids newly added. */
  certificationsAdded?: string[];
  /** Certification ids removed. */
  certificationsRemoved?: string[];
}

/** The five change counts the planner derives, surfaced in the audit metadata, the analytics
 *  property and the post-approval email's "what changed" summary. */
export interface StaffApplicationEditCounts {
  ratingsAdjusted: number;
  productsAdded: number;
  productsRemoved: number;
  certificationsAdded: number;
  certificationsRemoved: number;
}
