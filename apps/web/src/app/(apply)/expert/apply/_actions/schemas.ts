import { z } from 'zod';

// ── Shared field schemas (single source of truth) ────────────────
// Each strict field is factored into a named const so the strict (submit + client
// "Next" gate) and lenient (autosave draft) variants stay in lockstep — the draft
// variants only loosen `.min(1)` arrays and make required scalars optional.

const yearStartedSalesforceField = z
  .number({ message: 'Select a valid value' })
  .int()
  .min(2000, 'Year must be 2000 or later')
  .max(new Date().getFullYear(), 'Year cannot be in the future');

const projectCountMinField = z.number({ message: 'Select a valid value' }).int().min(0);

const projectLeadCountMinField = z.number({ message: 'Select a valid value' }).int().min(0);

const linkedinSlugField = z
  .string()
  .regex(/^[a-zA-Z0-9-]+$/, 'Only letters, numbers, and hyphens allowed')
  .optional()
  .or(z.literal(''));

const isSalesforceMvpField = z.boolean();
const isSalesforceCtaField = z.boolean();
const isCertifiedTrainerField = z.boolean();

const languageItem = z.object({
  languageId: z.string().uuid(),
  proficiency: z.enum(['beginner', 'intermediate', 'advanced', 'native']),
});

const industryIdItem = z.string().uuid();
const productIdItem = z.string().uuid();

const ratingItem = z.object({
  productId: z.string().uuid(),
  supportTypeId: z.string().uuid(),
  proficiency: z.number().int().min(0).max(10),
});

// ── Step 1: Profile ──────────────────────────────────────────────

const profileStepBase = z.object({
  yearStartedSalesforce: yearStartedSalesforceField,
  projectCountMin: projectCountMinField,
  projectLeadCountMin: projectLeadCountMinField,
  linkedinSlug: linkedinSlugField,
  isSalesforceMvp: isSalesforceMvpField,
  isSalesforceCta: isSalesforceCtaField,
  isCertifiedTrainer: isCertifiedTrainerField,
  languages: z.array(languageItem).min(1, 'Please add at least one language you can consult in.'),
  industryIds: z.array(industryIdItem).min(1, 'Please select at least one industry.'),
});

const projectLeadRefineOpts = {
  message: "This can't exceed your total project count",
  path: ['projectLeadCountMin'] as PropertyKey[],
};

export const profileStepSchema = profileStepBase.refine(
  (data) => data.projectLeadCountMin <= data.projectCountMin,
  projectLeadRefineOpts
);

// ── Step 2: Products ─────────────────────────────────────────────

// Shared array field so the `.max(50)` cap + message stay in lockstep between the
// strict (submit + "Next" gate) and lenient draft variants — only `.min(1)` differs.
const productIdsField = z.array(productIdItem).max(50, 'Too many products selected');

export const productsStepSchema = z.object({
  productIds: productIdsField.min(1, 'Please select at least one Salesforce product.'),
});

// ── Step 3: Assessment ───────────────────────────────────────────

const assessmentStepBase = z.object({
  ratings: z.array(ratingItem).max(500, 'Too many ratings'),
});

export const assessmentStepSchema = assessmentStepBase.refine(
  (data) => {
    // Group by productId, ensure each product has at least 1 non-zero rating
    const byProduct = new Map<string, number[]>();
    for (const r of data.ratings) {
      const arr = byProduct.get(r.productId) ?? [];
      arr.push(r.proficiency);
      byProduct.set(r.productId, arr);
    }
    for (const [, proficiencies] of byProduct) {
      if (!proficiencies.some((p) => p > 0)) return false;
    }
    return true;
  },
  { message: 'Please rate at least one dimension for each product.' }
);

// ── Step 4: Certifications (optional) ────────────────────────────

export const certificationsStepSchema = z.object({
  trailheadSlug: z
    .string()
    .regex(/^[a-zA-Z0-9-]*$/, 'Please enter a valid Trailhead username')
    .optional()
    .or(z.literal('')),
  certifications: z
    .array(
      z.object({
        certificationId: z.string().uuid(),
        earnedAt: z.string().optional().or(z.literal('')),
        expiresAt: z.string().optional().or(z.literal('')),
        credentialUrl: z.string().url('Please enter a valid URL').optional().or(z.literal('')),
      })
    )
    .max(100, 'Too many certifications'),
});

// ── Step 5: Work History (optional) ──────────────────────────────

const workHistoryEntrySchema = z
  .object({
    id: z.string().uuid().optional(), // existing entry ID for edits
    role: z.string().min(1, 'Role is required'),
    company: z.string().min(1, 'Company is required'),
    startedAt: z.string().min(1, 'Start date is required'),
    endedAt: z.string().optional().or(z.literal('')),
    isCurrent: z.boolean(),
    responsibilities: z.string().max(1000).optional().or(z.literal('')),
  })
  .refine(
    (data) => {
      if (data.isCurrent) return true;
      if (!data.endedAt) return true;
      return new Date(data.startedAt) < new Date(data.endedAt);
    },
    { message: 'End date must be after the start date', path: ['endedAt'] }
  );

export const workHistoryStepSchema = z.object({
  entries: z.array(workHistoryEntrySchema).max(50, 'Too many entries'),
});

// ── Step 6: Terms ────────────────────────────────────────────────

export const termsStepSchema = z.object({
  termsAccepted: z
    .boolean()
    .refine((v) => v === true, { message: 'You must accept the terms to continue' }),
});

// ── Draft (autosave) variants — lenient ──────────────────────────
// Consumed ONLY by saveDraftAction. Arrays may be empty (drop `.min(1)`), required
// scalars are optional, and completeness-only refines are dropped. Data-quality
// refines (linkedin/trailhead format, lead<=total, work-history end-after-start)
// are kept. The strict variants above are unchanged.

const profileStepDraftBase = profileStepBase
  .partial({
    yearStartedSalesforce: true,
    projectCountMin: true,
    projectLeadCountMin: true,
    isSalesforceMvp: true,
    isSalesforceCta: true,
    isCertifiedTrainer: true,
  })
  .extend({
    languages: z.array(languageItem),
    industryIds: z.array(industryIdItem),
  });

export const profileStepDraftSchema = profileStepDraftBase.refine(
  (data) =>
    data.projectLeadCountMin === undefined ||
    data.projectCountMin === undefined ||
    data.projectLeadCountMin <= data.projectCountMin,
  projectLeadRefineOpts
);

export const productsStepDraftSchema = z.object({
  productIds: productIdsField,
});

export const assessmentStepDraftSchema = assessmentStepBase;

export const termsStepDraftSchema = z.object({
  termsAccepted: z.boolean().optional(),
});

// ── Inferred types ───────────────────────────────────────────────

export type ProfileStepData = z.infer<typeof profileStepSchema>;
export type ProductsStepData = z.infer<typeof productsStepSchema>;
export type AssessmentStepData = z.infer<typeof assessmentStepSchema>;
export type CertificationsStepData = z.infer<typeof certificationsStepSchema>;
export type WorkHistoryStepData = z.infer<typeof workHistoryStepSchema>;
export type TermsStepData = z.infer<typeof termsStepSchema>;

export type ProfileStepDraftData = z.infer<typeof profileStepDraftSchema>;
export type ProductsStepDraftData = z.infer<typeof productsStepDraftSchema>;
export type AssessmentStepDraftData = z.infer<typeof assessmentStepDraftSchema>;

// ── Step metadata (data-driven iteration) ────────────────────────

export const STEP_CONFIG = [
  { key: 'profile', label: 'Your Profile', shortLabel: 'Profile', required: true },
  { key: 'products', label: 'Products', shortLabel: 'Products', required: true },
  {
    key: 'assessment',
    label: 'Self-Assessment',
    shortLabel: 'Assessment',
    required: true,
  },
  {
    key: 'certifications',
    label: 'Certifications',
    shortLabel: 'Certifications',
    required: false,
  },
  {
    key: 'work-history',
    label: 'Work History',
    shortLabel: 'History',
    required: false,
  },
  { key: 'terms', label: 'Terms', shortLabel: 'Terms', required: true },
] as const;

export type StepKey = (typeof STEP_CONFIG)[number]['key'];

/** Map from StepKey to its strict Zod schema (submit + client "Next" gate). */
export const STEP_SCHEMAS: Record<StepKey, z.ZodType> = {
  profile: profileStepSchema,
  products: productsStepSchema,
  assessment: assessmentStepSchema,
  certifications: certificationsStepSchema,
  'work-history': workHistoryStepSchema,
  terms: termsStepSchema,
};

/**
 * Map from StepKey to its lenient DRAFT Zod schema — consumed ONLY by
 * saveDraftAction. Half-filled drafts (empty arrays, omitted scalars, unchecked
 * terms) persist; only data-quality rules survive. Certifications / work-history
 * are already lenient, so they reuse their strict schema.
 */
export const STEP_DRAFT_SCHEMAS: Record<StepKey, z.ZodType> = {
  profile: profileStepDraftSchema,
  products: productsStepDraftSchema,
  assessment: assessmentStepDraftSchema,
  certifications: certificationsStepSchema,
  'work-history': workHistoryStepSchema,
  terms: termsStepDraftSchema,
};
