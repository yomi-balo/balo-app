/**
 * The pure planner behind `expertsRepository.editApplicationAsStaff`: given the application as
 * read under the profile row lock (the SNAPSHOT) and the staff-authored DELTA, it works out the
 * concrete writes, the change counts, the sections touched and the `expert_application.edited`
 * audit metadata.
 *
 * PURE. No I/O, no clock. Every "before" value comes from the snapshot, never from the client:
 * the delta only says what the caller wants, and anything that turns out to be a no-op against
 * the locked rows (a rating already at that value, a product already removed, a cert already
 * present) drops out here, so it is neither written nor audited.
 *
 * Ids only — no names and no free text reach the audit metadata.
 */
import {
  EXPERT_APPLICATION_EDIT_SECTIONS,
  type ExpertApplicationEditSection,
  type StaffApplicationEdit,
  type StaffApplicationEditCounts,
  type StaffEditableApplicationStatus,
} from '@balo/shared/experts';

/** The six experience scalars a staff edit may change, in display order. */
export const STAFF_EDIT_EXPERIENCE_FIELDS = [
  'yearStartedSalesforce',
  'projectCountMin',
  'projectLeadCountMin',
  'isSalesforceMvp',
  'isSalesforceCta',
  'isCertifiedTrainer',
] as const;

export type StaffEditExperienceField = (typeof STAFF_EDIT_EXPERIENCE_FIELDS)[number];

type StaffEditLanguage = NonNullable<StaffApplicationEdit['languages']>[number];
type StaffEditExperience = NonNullable<StaffApplicationEdit['experience']>;

/** The application as read with the transaction's handle, after the profile row lock. */
export interface StaffEditSnapshot {
  profile: {
    yearStartedSalesforce: number | null;
    projectCountMin: number | null;
    projectLeadCountMin: number | null;
    isSalesforceMvp: boolean;
    isSalesforceCta: boolean;
    isCertifiedTrainer: boolean;
  };
  competencies: {
    productId: string;
    supportTypeId: string;
    proficiency: number;
    selfProficiency: number | null;
  }[];
  certificationIds: string[];
  languages: StaffEditLanguage[];
  industryIds: string[];
}

/** One rating cell changed on a product the application keeps. */
export interface StaffEditRatingChange {
  productId: string;
  supportTypeId: string;
  before: number;
  after: number;
  /** The expert's own rating on that cell, carried for the reviewer's context. */
  selfProficiency: number | null;
}

/** A product that was not on the application and now is. */
export interface StaffEditProductAdded {
  productId: string;
  ratings: { supportTypeId: string; proficiency: number }[];
}

/** A product taken off the application, with every cell it held at the moment of removal. */
export interface StaffEditProductRemoved {
  productId: string;
  ratings: { supportTypeId: string; proficiency: number; selfProficiency: number | null }[];
}

/**
 * The change half of the `expert_application.edited` audit metadata. Every key is always present;
 * a group with nothing in it is `null` (or an empty array, for the three list-shaped groups).
 */
export interface ExpertApplicationEditChanges {
  sections: ExpertApplicationEditSection[];
  counts: StaffApplicationEditCounts;
  /** Changed fields only. */
  experience: Partial<
    Record<StaffEditExperienceField, { before: number | boolean | null; after: number | boolean }>
  > | null;
  languages: {
    added: StaffEditLanguage[];
    removed: StaffEditLanguage[];
    changed: { languageId: string; before: string; after: string }[];
  } | null;
  industries: { added: string[]; removed: string[] } | null;
  ratings: StaffEditRatingChange[];
  productsAdded: StaffEditProductAdded[];
  productsRemoved: StaffEditProductRemoved[];
  certifications: { added: string[]; removed: string[] } | null;
}

/**
 * The full `expert_application.edited` audit metadata (fixed key set). `audit_events` is
 * append-only, so this shape is pinned key-by-key in the integration suite.
 */
export interface ExpertApplicationEditedAuditMetadata extends ExpertApplicationEditChanges {
  /** From the LOCKED row. */
  applicationStatus: StaffEditableApplicationStatus;
  /** The locked row's `userId`. */
  applicantUserId: string;
}

/** What `editApplicationAsStaff` writes, plus what it records. */
export interface StaffEditPlan {
  /** The changed experience scalars, or `null` for no profile write. */
  experience: StaffEditExperience | null;
  /** The full language set to write, or `null` when it is unchanged. */
  languages: StaffEditLanguage[] | null;
  /** The full industry set to write, or `null` when it is unchanged. */
  industryIds: string[] | null;
  /** Product ids whose competency rows are deleted. */
  productIdsToRemove: string[];
  /** Rows inserted for genuinely new products — `selfProficiency` stays NULL. */
  competenciesToInsert: { productId: string; supportTypeId: string; proficiency: number }[];
  /** Existing cells whose effective `proficiency` changes. `selfProficiency` is never written. */
  ratingUpdates: { productId: string; supportTypeId: string; proficiency: number }[];
  certificationIdsToAdd: string[];
  certificationIdsToRemove: string[];
  sections: ExpertApplicationEditSection[];
  counts: StaffApplicationEditCounts;
  changes: ExpertApplicationEditChanges;
}

function cellKey(productId: string, supportTypeId: string): string {
  return `${productId}|${supportTypeId}`;
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function planExperience(
  profile: StaffEditSnapshot['profile'],
  experience: StaffEditExperience | undefined
): { write: StaffEditExperience | null; audit: ExpertApplicationEditChanges['experience'] } {
  if (experience === undefined) return { write: null, audit: null };
  const write: StaffEditExperience = {};
  const audit: NonNullable<ExpertApplicationEditChanges['experience']> = {};
  for (const field of STAFF_EDIT_EXPERIENCE_FIELDS) {
    const after = experience[field];
    if (after === undefined || after === profile[field]) continue;
    Object.assign(write, { [field]: after });
    audit[field] = { before: profile[field], after };
  }
  return Object.keys(audit).length === 0 ? { write: null, audit: null } : { write, audit };
}

function planLanguages(
  current: readonly StaffEditLanguage[],
  next: readonly StaffEditLanguage[] | undefined
): { write: StaffEditLanguage[] | null; audit: ExpertApplicationEditChanges['languages'] } {
  if (next === undefined) return { write: null, audit: null };
  const currentById = new Map(current.map((l) => [l.languageId, l]));
  const nextById = new Map(next.map((l) => [l.languageId, l]));
  const added = [...nextById.values()].filter((l) => !currentById.has(l.languageId));
  const removed = [...currentById.values()].filter((l) => !nextById.has(l.languageId));
  const changed: { languageId: string; before: string; after: string }[] = [];
  for (const l of nextById.values()) {
    const before = currentById.get(l.languageId);
    if (before !== undefined && before.proficiency !== l.proficiency) {
      changed.push({ languageId: l.languageId, before: before.proficiency, after: l.proficiency });
    }
  }
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return { write: null, audit: null };
  }
  return { write: [...nextById.values()], audit: { added, removed, changed } };
}

function planIndustries(
  current: readonly string[],
  next: readonly string[] | undefined
): { write: string[] | null; audit: ExpertApplicationEditChanges['industries'] } {
  if (next === undefined) return { write: null, audit: null };
  const currentSet = new Set(current);
  const nextIds = unique(next);
  const nextSet = new Set(nextIds);
  const added = nextIds.filter((id) => !currentSet.has(id));
  const removed = unique(current).filter((id) => !nextSet.has(id));
  if (added.length === 0 && removed.length === 0) return { write: null, audit: null };
  return { write: nextIds, audit: { added, removed } };
}

/**
 * True when the delta touches `projectCountMin` and/or `projectLeadCountMin`, AND the EFFECTIVE
 * experience that would result — the locked snapshot's value for each, overridden by the delta's
 * value when the delta provides one — would leave the lead-count floor above the project-count
 * floor. Checked ahead of `planStaffApplicationEdit`, against the raw snapshot and edit, so an
 * invalid combination is caught before any plan is built and never reaches a write.
 *
 * A delta that sets neither count never fires this, even against a snapshot whose stored pair is
 * already bad (e.g. a Bubble import) — an edit that doesn't touch either count must not be
 * blocked by data it didn't write.
 */
export function staffEditExperienceIsInvalid(
  profile: StaffEditSnapshot['profile'],
  experience: StaffEditExperience | undefined
): boolean {
  const deltaProjectCountMin = experience?.projectCountMin;
  const deltaProjectLeadCountMin = experience?.projectLeadCountMin;
  if (deltaProjectCountMin === undefined && deltaProjectLeadCountMin === undefined) return false;
  const projectCountMin = deltaProjectCountMin ?? profile.projectCountMin;
  const projectLeadCountMin = deltaProjectLeadCountMin ?? profile.projectLeadCountMin;
  if (projectCountMin === null || projectLeadCountMin === null) return false;
  return projectLeadCountMin > projectCountMin;
}

/**
 * Plans one staff edit against the locked snapshot. Each rule below is pinned by a unit test in
 * `expert-application-edit.test.ts`.
 *
 * - experience: only provided fields that differ from the snapshot.
 * - languages / industries: a set diff; no difference → `null` and no write.
 * - productsRemoved: only products present in the snapshot; each removed cell keeps its
 *   `proficiency` and `selfProficiency` in the audit.
 * - productsAdded: a product absent from the snapshot is a real add. One already present (a
 *   concurrent re-add) degrades to rating changes on its existing cells, keeping self-ratings.
 *   A real add with no ratings writes nothing and is dropped.
 * - ratings: a change only when the cell exists in the snapshot, its product is not being
 *   removed, and the value differs. Missing cells are skipped.
 * - certifications: adds keep only ids not present; removals keep only ids present.
 */
export function planStaffApplicationEdit(
  snapshot: StaffEditSnapshot,
  edit: StaffApplicationEdit
): StaffEditPlan {
  const experience = planExperience(snapshot.profile, edit.experience);
  const languages = planLanguages(snapshot.languages, edit.languages);
  const industries = planIndustries(snapshot.industryIds, edit.industryIds);

  const cells = new Map(
    snapshot.competencies.map((c) => [cellKey(c.productId, c.supportTypeId), c])
  );
  const presentProductIds = new Set(snapshot.competencies.map((c) => c.productId));

  // Removals: only products the application actually holds.
  const productIdsToRemove = unique(edit.productsRemoved ?? []).filter((id) =>
    presentProductIds.has(id)
  );
  const removing = new Set(productIdsToRemove);
  const productsRemoved: StaffEditProductRemoved[] = productIdsToRemove.map((productId) => ({
    productId,
    ratings: snapshot.competencies
      .filter((c) => c.productId === productId)
      .map((c) => ({
        supportTypeId: c.supportTypeId,
        proficiency: c.proficiency,
        selfProficiency: c.selfProficiency,
      })),
  }));

  // Adds: real adds versus re-adds of a product already present. Later entries win.
  const addsByProduct = new Map((edit.productsAdded ?? []).map((p) => [p.productId, p.ratings]));
  const productsAdded: StaffEditProductAdded[] = [];
  const requestedCells = new Map<
    string,
    { productId: string; supportTypeId: string; proficiency: number }
  >();
  for (const [productId, ratings] of addsByProduct) {
    if (presentProductIds.has(productId)) {
      for (const r of ratings) {
        requestedCells.set(cellKey(productId, r.supportTypeId), { productId, ...r });
      }
      continue;
    }
    const byType = new Map(ratings.map((r) => [r.supportTypeId, r.proficiency]));
    if (byType.size === 0) continue;
    productsAdded.push({
      productId,
      ratings: [...byType].map(([supportTypeId, proficiency]) => ({ supportTypeId, proficiency })),
    });
  }
  for (const r of edit.ratings ?? []) {
    requestedCells.set(cellKey(r.productId, r.supportTypeId), r);
  }

  // Rating changes: an existing cell, on a product that stays, whose value differs.
  const ratings: StaffEditRatingChange[] = [];
  for (const [key, requested] of requestedCells) {
    const cell = cells.get(key);
    if (cell === undefined || removing.has(cell.productId)) continue;
    if (cell.proficiency === requested.proficiency) continue;
    ratings.push({
      productId: cell.productId,
      supportTypeId: cell.supportTypeId,
      before: cell.proficiency,
      after: requested.proficiency,
      selfProficiency: cell.selfProficiency,
    });
  }

  const presentCerts = new Set(snapshot.certificationIds);
  const certificationIdsToAdd = unique(edit.certificationsAdded ?? []).filter(
    (id) => !presentCerts.has(id)
  );
  const certificationIdsToRemove = unique(edit.certificationsRemoved ?? []).filter((id) =>
    presentCerts.has(id)
  );

  const counts: StaffApplicationEditCounts = {
    ratingsAdjusted: ratings.length,
    productsAdded: productsAdded.length,
    productsRemoved: productsRemoved.length,
    certificationsAdded: certificationIdsToAdd.length,
    certificationsRemoved: certificationIdsToRemove.length,
  };

  const touched: Record<ExpertApplicationEditSection, boolean> = {
    ratings: counts.ratingsAdjusted > 0,
    products: counts.productsAdded > 0 || counts.productsRemoved > 0,
    certifications: counts.certificationsAdded > 0 || counts.certificationsRemoved > 0,
    experience: experience.audit !== null || languages.audit !== null || industries.audit !== null,
  };
  const sections = EXPERT_APPLICATION_EDIT_SECTIONS.filter((s) => touched[s]);

  const certificationChanges = touched.certifications
    ? { added: certificationIdsToAdd, removed: certificationIdsToRemove }
    : null;

  return {
    experience: experience.write,
    languages: languages.write,
    industryIds: industries.write,
    productIdsToRemove,
    competenciesToInsert: productsAdded.flatMap((p) =>
      p.ratings.map((r) => ({ productId: p.productId, ...r }))
    ),
    ratingUpdates: ratings.map((r) => ({
      productId: r.productId,
      supportTypeId: r.supportTypeId,
      proficiency: r.after,
    })),
    certificationIdsToAdd,
    certificationIdsToRemove,
    sections,
    counts,
    changes: {
      sections,
      counts,
      experience: experience.audit,
      languages: languages.audit,
      industries: industries.audit,
      ratings,
      productsAdded,
      productsRemoved,
      certifications: certificationChanges,
    },
  };
}
