import { z } from 'zod';

// ── Step 1: Profile ──────────────────────────────────────────────

export const profileStepSchema = z
  .object({
    phone: z
      .string()
      .min(6, 'Please enter a valid phone number')
      .max(15, 'Phone number is too long')
      .regex(/^\d+$/, 'Phone number must contain only digits'),
    countryCode: z
      .string()
      .min(1, 'Country code is required')
      .max(5, 'Invalid country code')
      .regex(/^\+\d+$/, 'Country code must start with + followed by digits'),
    yearStartedSalesforce: z
      .number({
        required_error: 'Select a valid value',
        invalid_type_error: 'Select a valid value',
      })
      .int()
      .min(2000, 'Year must be 2000 or later')
      .max(new Date().getFullYear(), 'Year cannot be in the future'),
    projectCountMin: z
      .number({
        required_error: 'Select a valid value',
        invalid_type_error: 'Select a valid value',
      })
      .int()
      .min(0),
    projectLeadCountMin: z
      .number({
        required_error: 'Select a valid value',
        invalid_type_error: 'Select a valid value',
      })
      .int()
      .min(0),
    linkedinSlug: z
      .string()
      .regex(/^[a-zA-Z0-9-]+$/, 'Only letters, numbers, and hyphens allowed')
      .optional()
      .or(z.literal('')),
    isSalesforceMvp: z.boolean(),
    isSalesforceCta: z.boolean(),
    isCertifiedTrainer: z.boolean(),
    languages: z
      .array(
        z.object({
          languageId: z.string().uuid(),
          proficiency: z.enum(['beginner', 'intermediate', 'advanced', 'native']),
        })
      )
      .min(1, 'Please add at least one language you can consult in.'),
    industryIds: z.array(z.string().uuid()).min(1, 'Please select at least one industry.'),
  })
  .refine((data) => data.projectLeadCountMin <= data.projectCountMin, {
    message: "This can't exceed your total project count",
    path: ['projectLeadCountMin'],
  });

// ── Step 2: Products ─────────────────────────────────────────────

export const productsStepSchema = z.object({
  skillIds: z
    .array(z.string().uuid())
    .min(1, 'Please select at least one Salesforce product.')
    .max(50, 'Too many products selected'),
});

// ── Step 3: Assessment ───────────────────────────────────────────

export const assessmentStepSchema = z
  .object({
    ratings: z
      .array(
        z.object({
          skillId: z.string().uuid(),
          supportTypeId: z.string().uuid(),
          proficiency: z.number().int().min(0).max(10),
        })
      )
      .max(500, 'Too many ratings'),
  })
  .refine(
    (data) => {
      // Group by skillId, ensure each skill has at least 1 non-zero rating
      const bySkill = new Map<string, number[]>();
      for (const r of data.ratings) {
        const arr = bySkill.get(r.skillId) ?? [];
        arr.push(r.proficiency);
        bySkill.set(r.skillId, arr);
      }
      for (const [, proficiencies] of bySkill) {
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

// ── Step 6: Invite (optional) ────────────────────────────────────

export const inviteStepSchema = z.object({
  emails: z.array(z.string().email('Invalid email format')).max(20, 'Too many invitations'),
});

// ── Step 7: Terms ────────────────────────────────────────────────

export const termsStepSchema = z.object({
  termsAccepted: z
    .boolean()
    .refine((v) => v === true, { message: 'You must accept the terms to continue' }),
});

// ── Inferred types ───────────────────────────────────────────────

export type ProfileStepData = z.infer<typeof profileStepSchema>;
export type ProductsStepData = z.infer<typeof productsStepSchema>;
export type AssessmentStepData = z.infer<typeof assessmentStepSchema>;
export type CertificationsStepData = z.infer<typeof certificationsStepSchema>;
export type WorkHistoryStepData = z.infer<typeof workHistoryStepSchema>;
export type InviteStepData = z.infer<typeof inviteStepSchema>;
export type TermsStepData = z.infer<typeof termsStepSchema>;

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
  { key: 'invite', label: 'Invite Experts', shortLabel: 'Invite', required: false },
  { key: 'terms', label: 'Terms', shortLabel: 'Terms', required: true },
] as const;

export type StepKey = (typeof STEP_CONFIG)[number]['key'];

/** Map from StepKey to its Zod schema (for data-driven validation) */
export const STEP_SCHEMAS: Record<StepKey, z.ZodType> = {
  profile: profileStepSchema,
  products: productsStepSchema,
  assessment: assessmentStepSchema,
  certifications: certificationsStepSchema,
  'work-history': workHistoryStepSchema,
  invite: inviteStepSchema,
  terms: termsStepSchema,
};
