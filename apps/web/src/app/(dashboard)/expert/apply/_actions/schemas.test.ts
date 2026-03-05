import { describe, it, expect } from 'vitest';
import {
  profileStepSchema,
  productsStepSchema,
  assessmentStepSchema,
  workHistoryStepSchema,
  termsStepSchema,
  certificationsStepSchema,
  inviteStepSchema,
} from './schemas';

describe('profileStepSchema', () => {
  const validData = {
    phone: '412345678',
    countryCode: '+61',
    yearStartedSalesforce: 2015,
    projectCountMin: 10,
    projectLeadCountMin: 1,
    linkedinSlug: 'john-doe',
    isSalesforceMvp: false,
    isSalesforceCta: false,
    isCertifiedTrainer: false,
    languages: [
      {
        languageId: 'a0000000-0000-4000-8000-000000000001',
        proficiency: 'native' as const,
      },
    ],
    industryIds: ['a0000000-0000-4000-8000-000000000001'],
  };

  it('accepts valid input', () => {
    expect(profileStepSchema.safeParse(validData).success).toBe(true);
  });

  it('rejects phone shorter than 6 digits', () => {
    const result = profileStepSchema.safeParse({ ...validData, phone: '123' });
    expect(result.success).toBe(false);
  });

  it('rejects year before 2000', () => {
    const result = profileStepSchema.safeParse({
      ...validData,
      yearStartedSalesforce: 1999,
    });
    expect(result.success).toBe(false);
  });

  it('rejects year in the future', () => {
    const result = profileStepSchema.safeParse({
      ...validData,
      yearStartedSalesforce: 2099,
    });
    expect(result.success).toBe(false);
  });

  it('rejects projectLeadCountMin exceeding projectCountMin', () => {
    const result = profileStepSchema.safeParse({
      ...validData,
      projectCountMin: 1,
      projectLeadCountMin: 10,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty languages array', () => {
    const result = profileStepSchema.safeParse({
      ...validData,
      languages: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty industryIds array', () => {
    const result = profileStepSchema.safeParse({
      ...validData,
      industryIds: [],
    });
    expect(result.success).toBe(false);
  });

  it('accepts empty linkedinSlug', () => {
    const result = profileStepSchema.safeParse({
      ...validData,
      linkedinSlug: '',
    });
    expect(result.success).toBe(true);
  });

  it('rejects linkedinSlug with special characters', () => {
    const result = profileStepSchema.safeParse({
      ...validData,
      linkedinSlug: 'john@doe',
    });
    expect(result.success).toBe(false);
  });

  it('accepts multiple languages with valid proficiencies', () => {
    const result = profileStepSchema.safeParse({
      ...validData,
      languages: [
        {
          languageId: 'a0000000-0000-4000-8000-000000000001',
          proficiency: 'native',
        },
        {
          languageId: 'a0000000-0000-4000-8000-000000000002',
          proficiency: 'intermediate',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid proficiency value', () => {
    const result = profileStepSchema.safeParse({
      ...validData,
      languages: [
        {
          languageId: 'a0000000-0000-4000-8000-000000000001',
          proficiency: 'expert',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts when projectLeadCountMin equals projectCountMin', () => {
    const result = profileStepSchema.safeParse({
      ...validData,
      projectCountMin: 5,
      projectLeadCountMin: 5,
    });
    expect(result.success).toBe(true);
  });

  it('rejects phone with non-digit characters', () => {
    const result = profileStepSchema.safeParse({
      ...validData,
      phone: '412-345-678',
    });
    expect(result.success).toBe(false);
  });

  it('rejects country code without + prefix', () => {
    const result = profileStepSchema.safeParse({
      ...validData,
      countryCode: '61',
    });
    expect(result.success).toBe(false);
  });

  it('rejects country code longer than 5 characters', () => {
    const result = profileStepSchema.safeParse({
      ...validData,
      countryCode: '+123456',
    });
    expect(result.success).toBe(false);
  });
});

describe('productsStepSchema', () => {
  it('accepts valid input with at least 1 skill', () => {
    expect(
      productsStepSchema.safeParse({
        skillIds: ['a0000000-0000-4000-8000-000000000001'],
      }).success
    ).toBe(true);
  });

  it('rejects empty skillIds', () => {
    expect(productsStepSchema.safeParse({ skillIds: [] }).success).toBe(false);
  });

  it('accepts multiple skill IDs', () => {
    expect(
      productsStepSchema.safeParse({
        skillIds: ['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002'],
      }).success
    ).toBe(true);
  });

  it('rejects non-UUID skillIds', () => {
    expect(productsStepSchema.safeParse({ skillIds: ['not-a-uuid'] }).success).toBe(false);
  });
});

describe('assessmentStepSchema', () => {
  it('accepts ratings where each skill has at least 1 non-zero', () => {
    const result = assessmentStepSchema.safeParse({
      ratings: [
        {
          skillId: 'a0000000-0000-4000-8000-000000000001',
          supportTypeId: 'a0000000-0000-4000-8000-000000000010',
          proficiency: 7,
        },
        {
          skillId: 'a0000000-0000-4000-8000-000000000001',
          supportTypeId: 'a0000000-0000-4000-8000-000000000011',
          proficiency: 0,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects ratings where a skill has all zeros', () => {
    const result = assessmentStepSchema.safeParse({
      ratings: [
        {
          skillId: 'a0000000-0000-4000-8000-000000000001',
          supportTypeId: 'a0000000-0000-4000-8000-000000000010',
          proficiency: 0,
        },
        {
          skillId: 'a0000000-0000-4000-8000-000000000001',
          supportTypeId: 'a0000000-0000-4000-8000-000000000011',
          proficiency: 0,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts when multiple skills all have at least 1 non-zero', () => {
    const result = assessmentStepSchema.safeParse({
      ratings: [
        {
          skillId: 'a0000000-0000-4000-8000-000000000001',
          supportTypeId: 'a0000000-0000-4000-8000-000000000010',
          proficiency: 5,
        },
        {
          skillId: 'a0000000-0000-4000-8000-000000000002',
          supportTypeId: 'a0000000-0000-4000-8000-000000000010',
          proficiency: 3,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects when one skill has all zeros while another does not', () => {
    const result = assessmentStepSchema.safeParse({
      ratings: [
        {
          skillId: 'a0000000-0000-4000-8000-000000000001',
          supportTypeId: 'a0000000-0000-4000-8000-000000000010',
          proficiency: 5,
        },
        {
          skillId: 'a0000000-0000-4000-8000-000000000002',
          supportTypeId: 'a0000000-0000-4000-8000-000000000010',
          proficiency: 0,
        },
        {
          skillId: 'a0000000-0000-4000-8000-000000000002',
          supportTypeId: 'a0000000-0000-4000-8000-000000000011',
          proficiency: 0,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects proficiency above 10', () => {
    const result = assessmentStepSchema.safeParse({
      ratings: [
        {
          skillId: 'a0000000-0000-4000-8000-000000000001',
          supportTypeId: 'a0000000-0000-4000-8000-000000000010',
          proficiency: 11,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative proficiency', () => {
    const result = assessmentStepSchema.safeParse({
      ratings: [
        {
          skillId: 'a0000000-0000-4000-8000-000000000001',
          supportTypeId: 'a0000000-0000-4000-8000-000000000010',
          proficiency: -1,
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('certificationsStepSchema', () => {
  it('accepts empty certifications (optional step)', () => {
    expect(certificationsStepSchema.safeParse({ certifications: [] }).success).toBe(true);
  });

  it('accepts certifications with valid data', () => {
    const result = certificationsStepSchema.safeParse({
      trailheadSlug: 'john-doe',
      certifications: [
        {
          certificationId: 'a0000000-0000-4000-8000-000000000001',
          earnedAt: '2024-01-01',
          expiresAt: '2025-01-01',
          credentialUrl: 'https://trailhead.salesforce.com/verify/123',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty trailheadSlug', () => {
    expect(
      certificationsStepSchema.safeParse({
        trailheadSlug: '',
        certifications: [],
      }).success
    ).toBe(true);
  });

  it('rejects invalid credential URL', () => {
    const result = certificationsStepSchema.safeParse({
      certifications: [
        {
          certificationId: 'a0000000-0000-4000-8000-000000000001',
          earnedAt: '',
          expiresAt: '',
          credentialUrl: 'not-a-url',
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('workHistoryStepSchema', () => {
  it('accepts empty entries (optional step)', () => {
    expect(workHistoryStepSchema.safeParse({ entries: [] }).success).toBe(true);
  });

  it('accepts valid work history entry', () => {
    const result = workHistoryStepSchema.safeParse({
      entries: [
        {
          role: 'Senior Consultant',
          company: 'Acme Corp',
          startedAt: '2020-01-01',
          endedAt: '2023-06-01',
          isCurrent: false,
          responsibilities: 'Led implementation projects.',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects end date before start date', () => {
    const result = workHistoryStepSchema.safeParse({
      entries: [
        {
          role: 'Dev',
          company: 'Acme',
          startedAt: '2024-06-01',
          endedAt: '2024-01-01',
          isCurrent: false,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('allows empty endedAt when isCurrent is true', () => {
    const result = workHistoryStepSchema.safeParse({
      entries: [
        {
          role: 'Dev',
          company: 'Acme',
          startedAt: '2024-01-01',
          isCurrent: true,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing role', () => {
    const result = workHistoryStepSchema.safeParse({
      entries: [
        {
          role: '',
          company: 'Acme',
          startedAt: '2024-01-01',
          isCurrent: true,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing company', () => {
    const result = workHistoryStepSchema.safeParse({
      entries: [
        {
          role: 'Dev',
          company: '',
          startedAt: '2024-01-01',
          isCurrent: true,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects responsibilities over 1000 characters', () => {
    const result = workHistoryStepSchema.safeParse({
      entries: [
        {
          role: 'Dev',
          company: 'Acme',
          startedAt: '2024-01-01',
          isCurrent: true,
          responsibilities: 'a'.repeat(1001),
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('inviteStepSchema', () => {
  it('accepts empty emails (optional step)', () => {
    expect(inviteStepSchema.safeParse({ emails: [] }).success).toBe(true);
  });

  it('accepts valid email addresses', () => {
    expect(
      inviteStepSchema.safeParse({
        emails: ['test@example.com', 'another@test.com'],
      }).success
    ).toBe(true);
  });

  it('rejects invalid email format', () => {
    expect(inviteStepSchema.safeParse({ emails: ['not-an-email'] }).success).toBe(false);
  });
});

describe('termsStepSchema', () => {
  it('accepts termsAccepted=true', () => {
    expect(termsStepSchema.safeParse({ termsAccepted: true }).success).toBe(true);
  });

  it('rejects termsAccepted=false', () => {
    expect(termsStepSchema.safeParse({ termsAccepted: false }).success).toBe(false);
  });

  it('rejects missing termsAccepted', () => {
    expect(termsStepSchema.safeParse({}).success).toBe(false);
  });
});
