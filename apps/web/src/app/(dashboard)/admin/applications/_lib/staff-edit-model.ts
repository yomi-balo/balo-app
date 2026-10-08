import type {
  StaffApplicationWithRelations,
  SupportType,
  ProductsByCategory,
  CertificationsByCategory,
  Language,
  Industry,
} from '@balo/db';
import { type StaffApplicationEdit, projectRangeLabel } from '@balo/shared/experts';

/**
 * BAL-593 §[F] — the staff edit form's client-safe view model and the delta planner that turns
 * two of them into the `StaffApplicationEdit` the Server Action sends. PURE and CLIENT-SAFE:
 * every `@balo/db` import above is type-only, so this module never drags the postgres driver
 * into the browser bundle (memory `reference_balo_db_client_bundle_footgun`).
 *
 * `StaffEditModel` is the form's working copy of ONE application — both the `initial` (the
 * locked-read snapshot the page loaded) and the `draft` (what the staffer has changed so far)
 * are this same shape, so `buildStaffEdit` is a plain diff between two values of one type.
 */

export interface StaffEditModel {
  experience: {
    yearStartedSalesforce: number | null;
    projectCountMin: number | null;
    projectLeadCountMin: number | null;
    isSalesforceMvp: boolean;
    isSalesforceCta: boolean;
    isCertifiedTrainer: boolean;
  };
  languages: NonNullable<StaffApplicationEdit['languages']>;
  industryIds: string[];
  /** Distinct competency product ids, in catalogue order (first appearance in `competencies`). */
  products: string[];
  /**
   * productId → supportTypeId → the pair of ratings. A retained product with no
   * `expert_competency` row for a support type has no real Balo rating to show — `missing: true`
   * marks that cell read-only (`balo: 0` is a placeholder, never a claim) so the form never
   * invents a rating the expert or Balo never gave. `buildStaffEdit` never emits it.
   */
  ratings: Record<string, Record<string, { self: number | null; balo: number; missing?: true }>>;
  certificationIds: string[];
}

export interface StaffEditReference {
  productsByCategory: ProductsByCategory[];
  supportTypes: SupportType[];
  certificationsByCategory: CertificationsByCategory[];
  languages: Language[];
  industries: Industry[];
}

/**
 * The three Salesforce-distinction flags, with the EXACT labels `buildDistinctions`
 * (`@/lib/expert/application-derived-data`) pushes for a true flag. Restated rather than
 * imported because that function's signature takes a full `ApplicationProfile`, and this module
 * only ever has the three booleans in isolation — the label strings are the one thing that must
 * never drift between the two.
 */
const DISTINCTION_FIELDS: readonly {
  key: 'isSalesforceMvp' | 'isSalesforceCta' | 'isCertifiedTrainer';
  label: string;
}[] = [
  { key: 'isSalesforceMvp', label: 'Salesforce MVP' },
  { key: 'isSalesforceCta', label: 'Salesforce CTA' },
  { key: 'isCertifiedTrainer', label: 'Certified Trainer' },
];

/** Builds the initial `StaffEditModel` from a locked application read and the vertical's support types. */
export function buildStaffEditModel(
  app: StaffApplicationWithRelations,
  supportTypes: SupportType[]
): StaffEditModel {
  const { profile, competencies, certifications, languages, industries, selfRatings } = app;

  const products: string[] = [];
  for (const competency of competencies) {
    if (!products.includes(competency.productId)) products.push(competency.productId);
  }

  const ratings: StaffEditModel['ratings'] = {};
  for (const productId of products) {
    const cells: Record<string, { self: number | null; balo: number; missing?: true }> = {};
    for (const supportType of supportTypes) {
      const competency = competencies.find(
        (c) => c.productId === productId && c.supportTypeId === supportType.id
      );
      if (competency === undefined) {
        cells[supportType.id] = { balo: 0, self: null, missing: true };
        continue;
      }
      const selfRow = selfRatings.find(
        (s) => s.productId === productId && s.supportTypeId === supportType.id
      );
      cells[supportType.id] = {
        balo: competency.proficiency,
        self: selfRow?.selfProficiency ?? null,
      };
    }
    ratings[productId] = cells;
  }

  return {
    experience: {
      yearStartedSalesforce: profile.yearStartedSalesforce,
      projectCountMin: profile.projectCountMin,
      projectLeadCountMin: profile.projectLeadCountMin,
      isSalesforceMvp: profile.isSalesforceMvp,
      isSalesforceCta: profile.isSalesforceCta,
      isCertifiedTrainer: profile.isCertifiedTrainer,
    },
    languages: languages.map((l) => ({ languageId: l.languageId, proficiency: l.proficiency })),
    industryIds: industries.map((i) => i.industryId),
    products,
    ratings,
    certificationIds: certifications.map((c) => c.certificationId),
  };
}

/** The full set differs — order-insensitive id comparison. */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every((id) => setA.has(id));
}

/** The full set differs — ids AND their proficiency, order-insensitive. */
function sameLanguageSet(a: StaffEditModel['languages'], b: StaffEditModel['languages']): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((l) => [l.languageId, l.proficiency]));
  return b.every((l) => byId.get(l.languageId) === l.proficiency);
}

/** The changed experience scalars only — `undefined` when none changed. */
function buildExperienceEdit(
  initial: StaffEditModel,
  draft: StaffEditModel
): NonNullable<StaffApplicationEdit['experience']> | undefined {
  const experience: NonNullable<StaffApplicationEdit['experience']> = {};
  if (
    typeof draft.experience.yearStartedSalesforce === 'number' &&
    draft.experience.yearStartedSalesforce !== initial.experience.yearStartedSalesforce
  ) {
    experience.yearStartedSalesforce = draft.experience.yearStartedSalesforce;
  }
  if (
    typeof draft.experience.projectCountMin === 'number' &&
    draft.experience.projectCountMin !== initial.experience.projectCountMin
  ) {
    experience.projectCountMin = draft.experience.projectCountMin;
  }
  if (
    typeof draft.experience.projectLeadCountMin === 'number' &&
    draft.experience.projectLeadCountMin !== initial.experience.projectLeadCountMin
  ) {
    experience.projectLeadCountMin = draft.experience.projectLeadCountMin;
  }
  if (draft.experience.isSalesforceMvp !== initial.experience.isSalesforceMvp) {
    experience.isSalesforceMvp = draft.experience.isSalesforceMvp;
  }
  if (draft.experience.isSalesforceCta !== initial.experience.isSalesforceCta) {
    experience.isSalesforceCta = draft.experience.isSalesforceCta;
  }
  if (draft.experience.isCertifiedTrainer !== initial.experience.isCertifiedTrainer) {
    experience.isCertifiedTrainer = draft.experience.isCertifiedTrainer;
  }
  return Object.keys(experience).length > 0 ? experience : undefined;
}

/** The three product id sets a diff needs: newly added, removed, and retained (present in both). */
function productIdDelta(
  initial: StaffEditModel,
  draft: StaffEditModel
): { added: string[]; removed: string[]; retained: string[] } {
  return {
    added: draft.products.filter((id) => !initial.products.includes(id)),
    removed: initial.products.filter((id) => !draft.products.includes(id)),
    retained: draft.products.filter((id) => initial.products.includes(id)),
  };
}

/**
 * Decision #10 — every added product carries one rating per support type the draft knows about,
 * defaulting to 0 for any cell the staffer never touched. The planner downstream
 * (`repositories/_shared/expert-application-edit.ts`) drops an empty `ratings` array, so an empty
 * set here would silently vanish rather than fail loudly.
 */
function buildProductsAddedEdit(
  draft: StaffEditModel,
  addedIds: readonly string[]
): NonNullable<StaffApplicationEdit['productsAdded']> {
  return addedIds.map((productId) => ({
    productId,
    ratings: Object.entries(draft.ratings[productId] ?? {}).map(([supportTypeId, cell]) => ({
      supportTypeId,
      proficiency: cell.balo,
    })),
  }));
}

/** A retained product's cell changed its Balo rating — a cell with no real rating never counts. */
function ratingCellChanged(
  before: StaffEditModel['ratings'][string][string] | undefined,
  now: StaffEditModel['ratings'][string][string]
): boolean {
  return before !== undefined && !before.missing && before.balo !== now.balo;
}

/** Changed ratings on RETAINED products only — a product added or removed is never represented here too. */
function buildRetainedRatingsEdit(
  initial: StaffEditModel,
  draft: StaffEditModel,
  retainedIds: readonly string[]
): NonNullable<StaffApplicationEdit['ratings']> {
  const ratings: NonNullable<StaffApplicationEdit['ratings']> = [];
  for (const productId of retainedIds) {
    const initialCells = initial.ratings[productId] ?? {};
    const draftCells = draft.ratings[productId] ?? {};
    for (const [supportTypeId, cell] of Object.entries(draftCells)) {
      if (ratingCellChanged(initialCells[supportTypeId], cell)) {
        ratings.push({ productId, supportTypeId, proficiency: cell.balo });
      }
    }
  }
  return ratings;
}

/** The products/ratings slice of the delta — added, removed and retained-rating changes. */
function buildProductsEdit(
  initial: StaffEditModel,
  draft: StaffEditModel
): Pick<StaffApplicationEdit, 'productsAdded' | 'productsRemoved' | 'ratings'> {
  const { added, removed, retained } = productIdDelta(initial, draft);
  const result: Pick<StaffApplicationEdit, 'productsAdded' | 'productsRemoved' | 'ratings'> = {};
  if (added.length > 0) result.productsAdded = buildProductsAddedEdit(draft, added);
  if (removed.length > 0) result.productsRemoved = removed;
  const ratings = buildRetainedRatingsEdit(initial, draft, retained);
  if (ratings.length > 0) result.ratings = ratings;
  return result;
}

/** Certification ids added or removed. */
function buildCertificationsEdit(
  initial: StaffEditModel,
  draft: StaffEditModel
): Pick<StaffApplicationEdit, 'certificationsAdded' | 'certificationsRemoved'> {
  const certificationsAdded = draft.certificationIds.filter(
    (id) => !initial.certificationIds.includes(id)
  );
  const certificationsRemoved = initial.certificationIds.filter(
    (id) => !draft.certificationIds.includes(id)
  );
  const result: Pick<StaffApplicationEdit, 'certificationsAdded' | 'certificationsRemoved'> = {};
  if (certificationsAdded.length > 0) result.certificationsAdded = certificationsAdded;
  if (certificationsRemoved.length > 0) result.certificationsRemoved = certificationsRemoved;
  return result;
}

/**
 * The delta between two models — every key optional, omitted when nothing in that key changed.
 * An edit that plans to nothing returns `{}` (H3's `no_changes`).
 */
export function buildStaffEdit(
  initial: StaffEditModel,
  draft: StaffEditModel
): StaffApplicationEdit {
  const edit: StaffApplicationEdit = {};

  const experience = buildExperienceEdit(initial, draft);
  if (experience !== undefined) edit.experience = experience;

  if (!sameLanguageSet(initial.languages, draft.languages)) {
    edit.languages = draft.languages;
  }

  if (!sameIdSet(initial.industryIds, draft.industryIds)) {
    edit.industryIds = draft.industryIds;
  }

  Object.assign(edit, buildProductsEdit(initial, draft));
  Object.assign(edit, buildCertificationsEdit(initial, draft));

  return edit;
}

/** One human-readable change line, grouped by its display section. */
interface StaffEditChange {
  section: string;
  text: string;
}

/** Looked-up display names for every id a change line might need to render. */
interface StaffEditChangeNames {
  productById: Map<string, string>;
  certById: Map<string, string>;
  languageById: Map<string, string>;
  industryById: Map<string, string>;
}

function buildStaffEditChangeNames(reference: StaffEditReference): StaffEditChangeNames {
  return {
    productById: new Map(
      reference.productsByCategory.flatMap((cat) =>
        cat.products.map((p) => [p.id, p.name] as const)
      )
    ),
    certById: new Map(
      reference.certificationsByCategory.flatMap((cat) =>
        cat.certifications.map((cert) => [cert.id, cert.name] as const)
      )
    ),
    languageById: new Map(reference.languages.map((l) => [l.id, l.name] as const)),
    industryById: new Map(reference.industries.map((i) => [i.id, i.name] as const)),
  };
}

function describeExperienceChanges(
  initial: StaffEditModel,
  draft: StaffEditModel
): StaffEditChange[] {
  const changes: StaffEditChange[] = [];
  if (initial.experience.yearStartedSalesforce !== draft.experience.yearStartedSalesforce) {
    changes.push({
      section: 'Experience',
      text: `Year started ${initial.experience.yearStartedSalesforce ?? '—'} → ${draft.experience.yearStartedSalesforce ?? '—'}`,
    });
  }
  if (initial.experience.projectCountMin !== draft.experience.projectCountMin) {
    changes.push({
      section: 'Experience',
      text: `Projects involved in ${projectRangeLabel(initial.experience.projectCountMin)} → ${projectRangeLabel(draft.experience.projectCountMin)}`,
    });
  }
  if (initial.experience.projectLeadCountMin !== draft.experience.projectLeadCountMin) {
    changes.push({
      section: 'Experience',
      text: `Projects as lead ${projectRangeLabel(initial.experience.projectLeadCountMin)} → ${projectRangeLabel(draft.experience.projectLeadCountMin)}`,
    });
  }
  for (const { key, label } of DISTINCTION_FIELDS) {
    if (initial.experience[key] !== draft.experience[key]) {
      changes.push({
        section: 'Experience',
        text: `${draft.experience[key] ? 'Added' : 'Removed'} ${label}`,
      });
    }
  }
  return changes;
}

function describeLanguageChanges(
  initial: StaffEditModel,
  draft: StaffEditModel,
  languageById: Map<string, string>
): StaffEditChange[] {
  const changes: StaffEditChange[] = [];
  const initialLanguages = new Map(initial.languages.map((l) => [l.languageId, l.proficiency]));
  const draftLanguages = new Map(draft.languages.map((l) => [l.languageId, l.proficiency]));
  for (const [id, proficiency] of draftLanguages) {
    const name = languageById.get(id) ?? id;
    const before = initialLanguages.get(id);
    if (before === undefined) {
      changes.push({ section: 'Languages', text: `Added ${name} (${proficiency})` });
    } else if (before !== proficiency) {
      changes.push({ section: 'Languages', text: `${name} ${before} → ${proficiency}` });
    }
  }
  for (const [id] of initialLanguages) {
    if (!draftLanguages.has(id)) {
      changes.push({ section: 'Languages', text: `Removed ${languageById.get(id) ?? id}` });
    }
  }
  return changes;
}

function describeIndustryChanges(
  initial: StaffEditModel,
  draft: StaffEditModel,
  industryById: Map<string, string>
): StaffEditChange[] {
  const changes: StaffEditChange[] = [];
  for (const id of draft.industryIds) {
    if (!initial.industryIds.includes(id)) {
      changes.push({ section: 'Industries', text: `Added ${industryById.get(id) ?? id}` });
    }
  }
  for (const id of initial.industryIds) {
    if (!draft.industryIds.includes(id)) {
      changes.push({ section: 'Industries', text: `Removed ${industryById.get(id) ?? id}` });
    }
  }
  return changes;
}

function describeProductChanges(
  initial: StaffEditModel,
  draft: StaffEditModel,
  reference: StaffEditReference,
  productById: Map<string, string>
): StaffEditChange[] {
  const changes: StaffEditChange[] = [];
  for (const id of draft.products) {
    if (initial.products.includes(id)) continue;
    const name = productById.get(id) ?? id;
    const cells = draft.ratings[id] ?? {};
    const values = reference.supportTypes.map((st) => `${st.name} ${cells[st.id]?.balo ?? 0}`);
    changes.push({ section: 'Products', text: `Added ${name} (${values.join(', ')})` });
  }
  for (const id of initial.products) {
    if (!draft.products.includes(id)) {
      changes.push({ section: 'Products', text: `Removed ${productById.get(id) ?? id}` });
    }
  }
  return changes;
}

/** Retained products only; a product added or removed is reported by `describeProductChanges`, never here too. */
function describeRatingChanges(
  initial: StaffEditModel,
  draft: StaffEditModel,
  reference: StaffEditReference,
  productById: Map<string, string>
): StaffEditChange[] {
  const changes: StaffEditChange[] = [];
  for (const id of draft.products) {
    if (!initial.products.includes(id)) continue;
    const name = productById.get(id) ?? id;
    const initialCells = initial.ratings[id] ?? {};
    const draftCells = draft.ratings[id] ?? {};
    for (const supportType of reference.supportTypes) {
      const beforeCell = initialCells[supportType.id];
      const before = beforeCell?.balo;
      const now = draftCells[supportType.id]?.balo;
      if (beforeCell?.missing) continue;
      if (before !== undefined && now !== undefined && before !== now) {
        changes.push({
          section: 'Ratings',
          text: `${name}, ${supportType.name} ${before} → ${now}`,
        });
      }
    }
  }
  return changes;
}

function describeCertificationChanges(
  initial: StaffEditModel,
  draft: StaffEditModel,
  certById: Map<string, string>
): StaffEditChange[] {
  const changes: StaffEditChange[] = [];
  for (const id of draft.certificationIds) {
    if (!initial.certificationIds.includes(id)) {
      changes.push({ section: 'Certifications', text: `Added ${certById.get(id) ?? id}` });
    }
  }
  for (const id of initial.certificationIds) {
    if (!draft.certificationIds.includes(id)) {
      changes.push({ section: 'Certifications', text: `Removed ${certById.get(id) ?? id}` });
    }
  }
  return changes;
}

/**
 * The save bar's human-readable change list — ported from the design reference's
 * `diffApplication` (504-574), with ids resolved to names through `reference`. Section labels
 * are display labels (Experience / Languages / Industries / Products / Ratings /
 * Certifications) — a finer split than `EXPERT_APPLICATION_EDIT_SECTIONS`' four audit sections,
 * which fold Languages and Industries into `experience`. Each section's diff is its own pure
 * helper; this function only orders and concatenates them.
 */
export function describeStaffEditChanges(
  initial: StaffEditModel,
  draft: StaffEditModel,
  reference: StaffEditReference
): { section: string; text: string }[] {
  const { productById, certById, languageById, industryById } =
    buildStaffEditChangeNames(reference);

  return [
    ...describeExperienceChanges(initial, draft),
    ...describeLanguageChanges(initial, draft, languageById),
    ...describeIndustryChanges(initial, draft, industryById),
    ...describeProductChanges(initial, draft, reference, productById),
    ...describeRatingChanges(initial, draft, reference, productById),
    ...describeCertificationChanges(initial, draft, certById),
  ];
}
