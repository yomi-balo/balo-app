import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import {
  agencies,
  certifications,
  consultations,
  expertCertifications,
  expertIndustries,
  expertLanguages,
  expertProfiles,
  industries,
  languages,
  products,
  supportTypes,
  workHistory,
  type ExpertProfile,
} from '../schema';
import {
  userFactory,
  expertDraftFactory,
  expertFactory,
  searchExpertFactory,
  agencyFactory,
} from '../test/factories';
import { expertsRepository, isUniqueViolation } from './experts';
import { referenceDataRepository } from './reference-data';
import { usersRepository } from './users';

// Unique-suffix helper so inline taxonomy rows never collide across tests
// (slugs / language codes have unique indexes; transaction rollback resets
// data but a single test may seed several rows).
let taxonomySeq = 0;
function uniq(prefix: string): string {
  taxonomySeq++;
  return `${prefix}-${taxonomySeq}-${Date.now()}`;
}

// ── createDraft ─────────────────────────────────────────────────────

describe('expertsRepository.createDraft', () => {
  it('creates a draft with correct userId, verticalId, and applicationStatus', async () => {
    const user = await userFactory({ firstName: 'Bob', lastName: 'Jones' });
    const vertical = await referenceDataRepository.getSalesforceVertical();

    const profile = await expertsRepository.createDraft({
      userId: user.id,
      verticalId: vertical.id,
      type: 'freelancer',
      firstName: 'Bob',
      lastName: 'Jones',
    });

    expect(profile.id).toBeDefined();
    expect(profile.userId).toBe(user.id);
    expect(profile.verticalId).toBe(vertical.id);
    expect(profile.applicationStatus).toBe('draft');
  });

  it('auto-generates username from firstName and lastName', async () => {
    const user = await userFactory({ firstName: 'Jane', lastName: 'Roe' });
    const vertical = await referenceDataRepository.getSalesforceVertical();

    const profile = await expertsRepository.createDraft({
      userId: user.id,
      verticalId: vertical.id,
      type: 'freelancer',
      firstName: 'Jane',
      lastName: 'Roe',
    });

    expect(profile.username).toBe('jane-roe');
  });

  it('stores the expert type correctly', async () => {
    const user = await userFactory({ firstName: 'Zara', lastName: 'Khan' });
    const vertical = await referenceDataRepository.getSalesforceVertical();

    const profile = await expertsRepository.createDraft({
      userId: user.id,
      verticalId: vertical.id,
      type: 'freelancer',
      firstName: 'Zara',
      lastName: 'Khan',
    });

    expect(profile.id).toBeDefined();
    expect(profile.type).toBe('freelancer');
  });
});

// ── updateProfile ───────────────────────────────────────────────────

describe('expertsRepository.updateProfile', () => {
  it('updates headline and bio', async () => {
    const draft = await expertDraftFactory();

    await expertsRepository.updateProfile(draft.id, {
      headline: 'Salesforce Architect',
      bio: 'I build great things.',
    });

    const updated = await expertsRepository.findProfileById(draft.id);
    expect(updated?.headline).toBe('Salesforce Architect');
    expect(updated?.bio).toBe('I build great things.');
  });

  it('updates username', async () => {
    const draft = await expertDraftFactory();

    await expertsRepository.updateProfile(draft.id, {
      username: 'custom-username',
    });

    const updated = await expertsRepository.findProfileById(draft.id);
    expect(updated?.username).toBe('custom-username');
  });

  it('setting username to null clears it', async () => {
    const draft = await expertDraftFactory();

    // First set a username
    await expertsRepository.updateProfile(draft.id, {
      username: 'will-be-cleared',
    });
    const withUsername = await expertsRepository.findProfileById(draft.id);
    expect(withUsername?.username).toBe('will-be-cleared');

    // Then clear it
    await expertsRepository.updateProfile(draft.id, {
      username: null,
    });
    const cleared = await expertsRepository.findProfileById(draft.id);
    expect(cleared?.username).toBeNull();
  });

  it('does not affect other columns when not passed', async () => {
    const draft = await expertDraftFactory();

    // Set rateCents
    await expertsRepository.updateProfile(draft.id, {
      rateCents: 150,
    });

    // Update only headline — rateCents should remain
    await expertsRepository.updateProfile(draft.id, {
      headline: 'New headline',
    });

    const updated = await expertsRepository.findProfileById(draft.id);
    expect(updated?.headline).toBe('New headline');
    expect(updated?.rateCents).toBe(150);
  });
});

// ── linkAgency (BAL-356) ────────────────────────────────────────────

describe('expertsRepository.linkAgency', () => {
  it('sets agency_id on the profile', async () => {
    const draft = await expertDraftFactory();
    const agency = await agencyFactory();
    expect(draft.agencyId).toBeNull();

    await expertsRepository.linkAgency(draft.id, agency.id);

    const linked = await expertsRepository.findProfileById(draft.id);
    expect(linked?.agencyId).toBe(agency.id);
  });

  it('throws when the profile does not exist (no row updated)', async () => {
    const agency = await agencyFactory();
    await expect(expertsRepository.linkAgency(randomUUID(), agency.id)).rejects.toThrow(
      /not found/i
    );
  });
});

// ── checkUsernameAvailability ───────────────────────────────────────

describe('expertsRepository.checkUsernameAvailability', () => {
  it('returns true for an unused username', async () => {
    const result = await expertsRepository.checkUsernameAvailability('totally-unused-name');
    expect(result).toBe(true);
  });

  it('returns false for a username already taken by another expert', async () => {
    const draft1 = await expertDraftFactory();
    await expertsRepository.updateProfile(draft1.id, { username: 'taken-name' });

    const result = await expertsRepository.checkUsernameAvailability('taken-name');
    expect(result).toBe(false);
  });

  it('returns true when checking own current username with excludeProfileId', async () => {
    const draft1 = await expertDraftFactory();
    await expertsRepository.updateProfile(draft1.id, { username: 'my-own-name' });

    const result = await expertsRepository.checkUsernameAvailability('my-own-name', draft1.id);
    expect(result).toBe(true);
  });

  it('returns false when another expert has the username even with excludeProfileId for a different profile', async () => {
    const draft1 = await expertDraftFactory();
    await expertsRepository.updateProfile(draft1.id, { username: 'contested-name' });

    const draft2 = await expertDraftFactory();

    const result = await expertsRepository.checkUsernameAvailability('contested-name', draft2.id);
    expect(result).toBe(false);
  });
});

// ── syncIndustries ──────────────────────────────────────────────────

describe('expertsRepository.syncIndustries', () => {
  it('replaces all industry associations', async () => {
    const draft = await expertDraftFactory();

    const [ind1] = await db.insert(industries).values({ name: 'Tech', slug: 'tech' }).returning();
    const [ind2] = await db
      .insert(industries)
      .values({ name: 'Finance', slug: 'finance' })
      .returning();
    const [ind3] = await db
      .insert(industries)
      .values({ name: 'Healthcare', slug: 'healthcare' })
      .returning();

    // Sync with ind1 and ind2
    await expertsRepository.syncIndustries(draft.id, [ind1!.id, ind2!.id]);
    let rows = await db.query.expertIndustries.findMany({
      where: eq(expertIndustries.expertProfileId, draft.id),
    });
    expect(rows).toHaveLength(2);
    const industryIds = rows.map((r) => r.industryId).sort();
    expect(industryIds).toEqual([ind1!.id, ind2!.id].sort());

    // Replace with ind2 and ind3 (removes ind1, adds ind3)
    await expertsRepository.syncIndustries(draft.id, [ind2!.id, ind3!.id]);
    rows = await db.query.expertIndustries.findMany({
      where: eq(expertIndustries.expertProfileId, draft.id),
    });
    expect(rows).toHaveLength(2);
    const updatedIds = rows.map((r) => r.industryId).sort();
    expect(updatedIds).toEqual([ind2!.id, ind3!.id].sort());
  });

  it('empty array clears all industries', async () => {
    const draft = await expertDraftFactory();

    const [ind1] = await db
      .insert(industries)
      .values({ name: 'Energy', slug: 'energy' })
      .returning();

    await expertsRepository.syncIndustries(draft.id, [ind1!.id]);
    let rows = await db.query.expertIndustries.findMany({
      where: eq(expertIndustries.expertProfileId, draft.id),
    });
    expect(rows).toHaveLength(1);

    // Clear
    await expertsRepository.syncIndustries(draft.id, []);
    rows = await db.query.expertIndustries.findMany({
      where: eq(expertIndustries.expertProfileId, draft.id),
    });
    expect(rows).toHaveLength(0);
  });

  it('passing the same IDs is idempotent', async () => {
    const draft = await expertDraftFactory();

    const [ind1] = await db
      .insert(industries)
      .values({ name: 'Retail', slug: 'retail' })
      .returning();
    const [ind2] = await db
      .insert(industries)
      .values({ name: 'Logistics', slug: 'logistics' })
      .returning();

    const ids = [ind1!.id, ind2!.id];

    await expertsRepository.syncIndustries(draft.id, ids);
    await expertsRepository.syncIndustries(draft.id, ids);

    const rows = await db.query.expertIndustries.findMany({
      where: eq(expertIndustries.expertProfileId, draft.id),
    });
    expect(rows).toHaveLength(2);
    const industryIds = rows.map((r) => r.industryId).sort();
    expect(industryIds).toEqual(ids.sort());
  });
});

// ── syncLanguages ───────────────────────────────────────────────────

describe('expertsRepository.syncLanguages', () => {
  it('replaces all language associations with proficiency levels', async () => {
    const draft = await expertDraftFactory();

    const [lang1] = await db.insert(languages).values({ name: 'English', code: 'en' }).returning();
    const [lang2] = await db.insert(languages).values({ name: 'Spanish', code: 'es' }).returning();
    const [lang3] = await db.insert(languages).values({ name: 'French', code: 'fr' }).returning();

    // Sync with lang1 and lang2
    await expertsRepository.syncLanguages(draft.id, [
      { languageId: lang1!.id, proficiency: 'native' },
      { languageId: lang2!.id, proficiency: 'intermediate' },
    ]);
    let rows = await db.query.expertLanguages.findMany({
      where: eq(expertLanguages.expertProfileId, draft.id),
    });
    expect(rows).toHaveLength(2);

    const lang1Row = rows.find((r) => r.languageId === lang1!.id);
    expect(lang1Row?.proficiency).toBe('native');

    const lang2Row = rows.find((r) => r.languageId === lang2!.id);
    expect(lang2Row?.proficiency).toBe('intermediate');

    // Replace with lang2 (updated proficiency) and lang3
    await expertsRepository.syncLanguages(draft.id, [
      { languageId: lang2!.id, proficiency: 'advanced' },
      { languageId: lang3!.id, proficiency: 'beginner' },
    ]);
    rows = await db.query.expertLanguages.findMany({
      where: eq(expertLanguages.expertProfileId, draft.id),
    });
    expect(rows).toHaveLength(2);

    const updatedLang2 = rows.find((r) => r.languageId === lang2!.id);
    expect(updatedLang2?.proficiency).toBe('advanced');

    const lang3Row = rows.find((r) => r.languageId === lang3!.id);
    expect(lang3Row?.proficiency).toBe('beginner');

    // lang1 should be gone
    const lang1Gone = rows.find((r) => r.languageId === lang1!.id);
    expect(lang1Gone).toBeUndefined();
  });

  it('empty array clears all languages', async () => {
    const draft = await expertDraftFactory();

    const [lang1] = await db.insert(languages).values({ name: 'German', code: 'de' }).returning();

    await expertsRepository.syncLanguages(draft.id, [
      { languageId: lang1!.id, proficiency: 'native' },
    ]);
    let rows = await db.query.expertLanguages.findMany({
      where: eq(expertLanguages.expertProfileId, draft.id),
    });
    expect(rows).toHaveLength(1);

    // Clear
    await expertsRepository.syncLanguages(draft.id, []);
    rows = await db.query.expertLanguages.findMany({
      where: eq(expertLanguages.expertProfileId, draft.id),
    });
    expect(rows).toHaveLength(0);
  });
});

// ── findPublicProfileByUsername ─────────────────────────────────────

describe('expertsRepository.findPublicProfileByUsername', () => {
  it('returns the profile when approved + searchable + username matches', async () => {
    const username = uniq('approved-searchable');
    const expert = await searchExpertFactory({ username, searchable: true });

    const result = await expertsRepository.findPublicProfileByUsername(username);

    expect(result).toBeDefined();
    expect(result?.id).toBe(expert.id);
    expect(result?.username).toBe(username);
  });

  it('returns undefined for a draft (never submitted/approved)', async () => {
    const username = uniq('draft');
    const draft = await expertDraftFactory();
    await expertsRepository.updateProfile(draft.id, { username, searchable: true });

    const result = await expertsRepository.findPublicProfileByUsername(username);

    expect(result).toBeUndefined();
  });

  it('returns undefined when submitted but not approved', async () => {
    const username = uniq('submitted');
    const draft = await expertDraftFactory();
    await expertsRepository.updateProfile(draft.id, { username, searchable: true });
    await expertsRepository.submitApplication(draft.id);

    const result = await expertsRepository.findPublicProfileByUsername(username);

    expect(result).toBeUndefined();
  });

  it('returns undefined when approved but searchable is false', async () => {
    const username = uniq('not-searchable');
    // expertFactory approves but leaves searchable at its default (false).
    const expert = await expertFactory();
    await expertsRepository.updateProfile(expert.id, { username, searchable: false });

    const result = await expertsRepository.findPublicProfileByUsername(username);

    expect(result).toBeUndefined();
  });

  it('returns undefined when searchable is true but approvedAt is null (defensive)', async () => {
    const username = uniq('searchable-unapproved');
    const draft = await expertDraftFactory();
    await expertsRepository.updateProfile(draft.id, { username, searchable: true });
    // Force the defensive state directly: searchable=true yet approvedAt still NULL.
    await db
      .update(expertProfiles)
      .set({ approvedAt: null, searchable: true })
      .where(eq(expertProfiles.id, draft.id));

    const result = await expertsRepository.findPublicProfileByUsername(username);

    expect(result).toBeUndefined();
  });

  it('returns undefined for an unknown username', async () => {
    const result = await expertsRepository.findPublicProfileByUsername(uniq('does-not-exist'));

    expect(result).toBeUndefined();
  });

  it('eager-loads every relation and orders work history by sortOrder', async () => {
    // ── Seed taxonomy + agency rows the factory does not create itself ──
    const vertical = await referenceDataRepository.getSalesforceVertical();

    const [product] = await db
      .insert(products)
      .values({ verticalId: vertical.id, name: 'Apex', slug: uniq('apex') })
      .returning();
    const [supportType] = await db
      .insert(supportTypes)
      .values({ verticalId: vertical.id, name: 'Implementation', slug: uniq('implementation') })
      .returning();
    const [language] = await db
      .insert(languages)
      .values({ name: 'English', code: uniq('en'), flagEmoji: '🇬🇧' })
      .returning();
    const [industry] = await db
      .insert(industries)
      .values({ name: 'Healthcare', slug: uniq('healthcare') })
      .returning();
    const [certification] = await db
      .insert(certifications)
      .values({
        verticalId: vertical.id,
        name: 'Platform Developer I',
        slug: uniq('pd1'),
        logoUrl: 'https://cdn.example.com/pd1.png',
      })
      .returning();
    const [agency] = await db
      .insert(agencies)
      .values({ name: 'Cloud Partners', slug: uniq('cloud-partners'), logoUrl: 'logo-key' })
      .returning();

    if (!product || !supportType || !language || !industry || !certification || !agency) {
      throw new Error('Failed to seed taxonomy rows');
    }

    // User with avatar/timezone/country so we can assert the user columns load.
    const user = await userFactory({
      firstName: 'Ada',
      lastName: 'Lovelace',
      avatarUrl: 'avatar-key',
      timezone: 'Australia/Sydney',
      country: 'Australia',
      countryCode: 'AU',
    });

    const username = uniq('full-graph');
    const expert = await searchExpertFactory({
      userId: user.id,
      username,
      searchable: true,
      agencyId: agency.id,
      competencies: [{ productId: product.id, supportTypeId: supportType.id, proficiency: 8 }],
      languages: [{ languageId: language.id, proficiency: 'native' }],
    });

    // Certifications + industries + work history are seeded directly.
    await db.insert(expertCertifications).values({
      expertProfileId: expert.id,
      certificationId: certification.id,
    });
    await db.insert(expertIndustries).values({
      expertProfileId: expert.id,
      industryId: industry.id,
    });
    await db.insert(workHistory).values([
      {
        expertProfileId: expert.id,
        role: 'Senior Consultant',
        company: 'Beta Corp',
        startedAt: new Date('2020-01-01'),
        endedAt: new Date('2022-01-01'),
        isCurrent: false,
        sortOrder: 1,
      },
      {
        expertProfileId: expert.id,
        role: 'Lead Architect',
        company: 'Alpha Inc',
        startedAt: new Date('2022-02-01'),
        isCurrent: true,
        sortOrder: 0,
      },
    ]);

    const result = await expertsRepository.findPublicProfileByUsername(username);

    expect(result).toBeDefined();

    // user relation
    expect(result?.user.firstName).toBe('Ada');
    expect(result?.user.lastName).toBe('Lovelace');
    expect(result?.user.avatarUrl).toBe('avatar-key');
    expect(result?.user.countryCode).toBe('AU');
    expect(result?.user.timezone).toBe('Australia/Sydney');

    // agency relation
    expect(result?.agency?.name).toBe('Cloud Partners');
    expect(result?.agency?.slug).toBe(agency.slug);
    expect(result?.agency?.logoUrl).toBe('logo-key');

    // competencies (+ nested product & supportType)
    expect(result?.competencies).toHaveLength(1);
    expect(result?.competencies[0]?.product.name).toBe('Apex');
    expect(result?.competencies[0]?.supportType.name).toBe('Implementation');
    expect(result?.competencies[0]?.proficiency).toBe(8);

    // certifications (+ nested certification)
    expect(result?.certifications).toHaveLength(1);
    expect(result?.certifications[0]?.certification.name).toBe('Platform Developer I');
    expect(result?.certifications[0]?.certification.logoUrl).toBe(
      'https://cdn.example.com/pd1.png'
    );

    // languages (+ nested language)
    expect(result?.languages).toHaveLength(1);
    expect(result?.languages[0]?.language.name).toBe('English');
    expect(result?.languages[0]?.language.flagEmoji).toBe('🇬🇧');

    // industries (+ nested industry)
    expect(result?.industries).toHaveLength(1);
    expect(result?.industries[0]?.industry.name).toBe('Healthcare');

    // workHistory ordered by sortOrder asc (Lead Architect sortOrder 0 first)
    expect(result?.workHistory).toHaveLength(2);
    expect(result?.workHistory.map((wh) => wh.sortOrder)).toEqual([0, 1]);
    expect(result?.workHistory[0]?.role).toBe('Lead Architect');
    expect(result?.workHistory[0]?.isCurrent).toBe(true);
    expect(result?.workHistory[1]?.role).toBe('Senior Consultant');
  });

  it('counts only live confirmed consultations in consultationCount', async () => {
    const user = await userFactory();
    const username = uniq('consult-count');
    const expert = await searchExpertFactory({
      userId: user.id,
      username,
      searchable: true,
    });

    const start = new Date('2026-01-01T10:00:00.000Z');
    const end = new Date('2026-01-01T11:00:00.000Z');
    await db.insert(consultations).values([
      // 2 live confirmed → counted.
      { expertProfileId: expert.id, startAt: start, endAt: end, status: 'confirmed' },
      { expertProfileId: expert.id, startAt: start, endAt: end, status: 'confirmed' },
      // 1 cancelled → excluded.
      { expertProfileId: expert.id, startAt: start, endAt: end, status: 'cancelled' },
      // 1 soft-deleted confirmed → excluded.
      {
        expertProfileId: expert.id,
        startAt: start,
        endAt: end,
        status: 'confirmed',
        deletedAt: new Date(),
      },
    ]);

    const result = await expertsRepository.findPublicProfileByUsername(username);
    expect(result?.consultationCount).toBe(2);
  });

  it('reports a zero consultationCount when the expert has no consultations', async () => {
    const user = await userFactory();
    const username = uniq('consult-zero');
    await searchExpertFactory({ userId: user.id, username, searchable: true });

    const result = await expertsRepository.findPublicProfileByUsername(username);
    expect(result?.consultationCount).toBe(0);
  });
});

// ── findOrCreateDraft ────────────────────────────────────────────────

describe('expertsRepository.findOrCreateDraft', () => {
  it('is idempotent: two sequential calls for the same (userId, verticalId) converge on one row', async () => {
    const user = await userFactory({ firstName: 'Casey', lastName: 'Lane' });
    const vertical = await referenceDataRepository.getSalesforceVertical();
    const input = {
      userId: user.id,
      verticalId: vertical.id,
      type: 'freelancer' as const,
      firstName: 'Casey',
      lastName: 'Lane',
    };

    const first = await expertsRepository.findOrCreateDraft(input);
    // Second call MUST NOT throw on expert_user_vertical_idx; it adopts the row.
    const second = await expertsRepository.findOrCreateDraft(input);

    expect(first.id).toBe(second.id);

    const rows = await db.query.expertProfiles.findMany({
      where: and(eq(expertProfiles.userId, user.id), eq(expertProfiles.verticalId, vertical.id)),
    });
    expect(rows).toHaveLength(1);
  });

  it('adopts a pre-existing draft instead of inserting a new row', async () => {
    const user = await userFactory({ firstName: 'Dana', lastName: 'Reed' });
    const vertical = await referenceDataRepository.getSalesforceVertical();
    const draft = await expertDraftFactory({ userId: user.id, verticalId: vertical.id });

    const found = await expertsRepository.findOrCreateDraft({
      userId: user.id,
      verticalId: vertical.id,
      type: 'freelancer',
      firstName: 'Dana',
      lastName: 'Reed',
    });

    expect(found.id).toBe(draft.id);

    const rows = await db.query.expertProfiles.findMany({
      where: and(eq(expertProfiles.userId, user.id), eq(expertProfiles.verticalId, vertical.id)),
    });
    expect(rows).toHaveLength(1);
  });
});

// ── saveProfileStep ──────────────────────────────────────────────────

describe('expertsRepository.saveProfileStep', () => {
  it('creates the profile and writes scalars + languages + industries (happy path)', async () => {
    const user = await userFactory({ firstName: 'Ева', lastName: 'Stone' });
    const vertical = await referenceDataRepository.getSalesforceVertical();

    const [lang1] = await db
      .insert(languages)
      .values({ name: 'English', code: uniq('en') })
      .returning();
    const [lang2] = await db
      .insert(languages)
      .values({ name: 'Spanish', code: uniq('es') })
      .returning();
    const [ind1] = await db
      .insert(industries)
      .values({ name: 'Tech', slug: uniq('tech') })
      .returning();
    const [ind2] = await db
      .insert(industries)
      .values({ name: 'Finance', slug: uniq('finance') })
      .returning();
    if (!lang1 || !lang2 || !ind1 || !ind2) throw new Error('Failed to seed taxonomy');

    const profile = await expertsRepository.saveProfileStep(
      undefined,
      {
        userId: user.id,
        verticalId: vertical.id,
        type: 'freelancer',
        firstName: 'Eva',
        lastName: 'Stone',
      },
      {
        yearStartedSalesforce: 2018,
        projectCountMin: 10,
        projectLeadCountMin: 2,
        linkedinUrl: 'https://linkedin.com/in/eva-stone',
        isSalesforceMvp: true,
        isSalesforceCta: false,
        isCertifiedTrainer: false,
        languages: [
          { languageId: lang1.id, proficiency: 'native' },
          { languageId: lang2.id, proficiency: 'intermediate' },
        ],
        industryIds: [ind1.id, ind2.id],
      }
    );

    const saved = await expertsRepository.findProfileById(profile.id);
    expect(saved?.yearStartedSalesforce).toBe(2018);
    expect(saved?.projectCountMin).toBe(10);
    expect(saved?.projectLeadCountMin).toBe(2);
    expect(saved?.linkedinUrl).toBe('https://linkedin.com/in/eva-stone');
    expect(saved?.isSalesforceMvp).toBe(true);

    const langRows = await db.query.expertLanguages.findMany({
      where: eq(expertLanguages.expertProfileId, profile.id),
    });
    expect(langRows).toHaveLength(2);

    const indRows = await db.query.expertIndustries.findMany({
      where: eq(expertIndustries.expertProfileId, profile.id),
    });
    expect(indRows).toHaveLength(2);
  });

  it('rolls back the whole transaction on a mid-step failure — NO orphan row (headline AC)', async () => {
    const user = await userFactory({ firstName: 'Finn', lastName: 'Hart' });
    const vertical = await referenceDataRepository.getSalesforceVertical();

    const [lang1] = await db
      .insert(languages)
      .values({ name: 'German', code: uniq('de') })
      .returning();
    if (!lang1) throw new Error('Failed to seed language');

    // An industryId that violates the expert_industries.industry_id FK → the sync
    // throws mid-transaction, after the profile row + languages were written.
    await expect(
      expertsRepository.saveProfileStep(
        undefined,
        {
          userId: user.id,
          verticalId: vertical.id,
          type: 'freelancer',
          firstName: 'Finn',
          lastName: 'Hart',
        },
        {
          yearStartedSalesforce: 2019,
          projectCountMin: 5,
          projectLeadCountMin: 1,
          linkedinUrl: null,
          isSalesforceMvp: false,
          isSalesforceCta: false,
          isCertifiedTrainer: false,
          languages: [{ languageId: lang1.id, proficiency: 'native' }],
          industryIds: [randomUUID()],
        }
      )
    ).rejects.toThrow();

    // No expert_profiles row committed for this (userId, verticalId)…
    const profileRows = await db.query.expertProfiles.findMany({
      where: and(eq(expertProfiles.userId, user.id), eq(expertProfiles.verticalId, vertical.id)),
    });
    expect(profileRows).toHaveLength(0);

    // …and no partial languages left behind.
    const langRows = await db.query.expertLanguages.findMany({
      where: eq(expertLanguages.languageId, lang1.id),
    });
    expect(langRows).toHaveLength(0);
  });

  it('on the existing-id path, a mid-step failure leaves the prior profile state intact', async () => {
    const user = await userFactory({ firstName: 'Gita', lastName: 'Roy' });
    const vertical = await referenceDataRepository.getSalesforceVertical();
    const draft = await expertDraftFactory({ userId: user.id, verticalId: vertical.id });

    // Seed a known prior state.
    await expertsRepository.updateProfile(draft.id, { yearStartedSalesforce: 2010 });
    const [lang1] = await db
      .insert(languages)
      .values({ name: 'Italian', code: uniq('it') })
      .returning();
    if (!lang1) throw new Error('Failed to seed language');
    await expertsRepository.syncLanguages(draft.id, [
      { languageId: lang1.id, proficiency: 'native' },
    ]);

    await expect(
      expertsRepository.saveProfileStep(draft.id, undefined, {
        yearStartedSalesforce: 2022,
        projectCountMin: 8,
        projectLeadCountMin: 1,
        linkedinUrl: null,
        isSalesforceMvp: false,
        isSalesforceCta: false,
        isCertifiedTrainer: false,
        languages: [{ languageId: lang1.id, proficiency: 'advanced' }],
        industryIds: [randomUUID()], // invalid FK → rollback
      })
    ).rejects.toThrow();

    // The profile row survives (predates the tx) with its PRIOR scalar value.
    const saved = await expertsRepository.findProfileById(draft.id);
    expect(saved).toBeDefined();
    expect(saved?.yearStartedSalesforce).toBe(2010);

    // The prior language is unchanged (the failed step's child writes rolled back).
    const langRows = await db.query.expertLanguages.findMany({
      where: eq(expertLanguages.expertProfileId, draft.id),
    });
    expect(langRows).toHaveLength(1);
    expect(langRows[0]?.proficiency).toBe('native');
  });

  it('updates an existing draft in place (no second profile row)', async () => {
    const user = await userFactory({ firstName: 'Hugo', lastName: 'Vale' });
    const vertical = await referenceDataRepository.getSalesforceVertical();
    const draft = await expertDraftFactory({ userId: user.id, verticalId: vertical.id });

    const [ind1] = await db
      .insert(industries)
      .values({ name: 'Retail', slug: uniq('retail') })
      .returning();
    if (!ind1) throw new Error('Failed to seed industry');

    const result = await expertsRepository.saveProfileStep(draft.id, undefined, {
      yearStartedSalesforce: 2021,
      projectCountMin: 3,
      projectLeadCountMin: 0,
      linkedinUrl: null,
      isSalesforceMvp: false,
      isSalesforceCta: false,
      isCertifiedTrainer: false,
      languages: [],
      industryIds: [ind1.id],
    });

    expect(result.id).toBe(draft.id);

    const rows = await db.query.expertProfiles.findMany({
      where: and(eq(expertProfiles.userId, user.id), eq(expertProfiles.verticalId, vertical.id)),
    });
    expect(rows).toHaveLength(1);

    const saved = await expertsRepository.findProfileById(draft.id);
    expect(saved?.yearStartedSalesforce).toBe(2021);

    const indRows = await db.query.expertIndustries.findMany({
      where: eq(expertIndustries.expertProfileId, draft.id),
    });
    expect(indRows).toHaveLength(1);
  });
});

// ── saveCertificationsStep ───────────────────────────────────────────

describe('expertsRepository.saveCertificationsStep', () => {
  it('writes the trailhead URL and certifications in one transaction', async () => {
    const draft = await expertDraftFactory();
    const vertical = await referenceDataRepository.getSalesforceVertical();
    const [cert] = await db
      .insert(certifications)
      .values({ verticalId: vertical.id, name: 'Admin', slug: uniq('admin') })
      .returning();
    if (!cert) throw new Error('Failed to seed certification');

    await expertsRepository.saveCertificationsStep(draft.id, 'https://trailblazer.me/id/jane', [
      { certificationId: cert.id, earnedAt: '2024-01-01' },
    ]);

    const saved = await expertsRepository.findProfileById(draft.id);
    expect(saved?.trailheadUrl).toBe('https://trailblazer.me/id/jane');

    const certRows = await db.query.expertCertifications.findMany({
      where: eq(expertCertifications.expertProfileId, draft.id),
    });
    expect(certRows).toHaveLength(1);
  });

  it('rolls back the trailhead URL when the certification insert fails', async () => {
    const draft = await expertDraftFactory();
    await expectAssertNoTrailhead(draft.id);

    await expect(
      expertsRepository.saveCertificationsStep(draft.id, 'https://trailblazer.me/id/bob', [
        { certificationId: randomUUID() }, // invalid FK → rollback
      ])
    ).rejects.toThrow();

    const saved = await expertsRepository.findProfileById(draft.id);
    expect(saved?.trailheadUrl).toBeNull();

    // The child certification write rolled back too — no partial rows left behind.
    const certRows = await db.query.expertCertifications.findMany({
      where: eq(expertCertifications.expertProfileId, draft.id),
    });
    expect(certRows).toHaveLength(0);
  });
});

async function expectAssertNoTrailhead(profileId: string): Promise<void> {
  const before = await expertsRepository.findProfileById(profileId);
  expect(before?.trailheadUrl).toBeNull();
}

// ── findUserIdByProfileId ────────────────────────────────────────────

describe('expertsRepository.findUserIdByProfileId', () => {
  it('returns the underlying user id for an existing profile', async () => {
    const user = await userFactory();
    const draft = await expertDraftFactory({ userId: user.id });

    const result = await expertsRepository.findUserIdByProfileId(draft.id);

    expect(result).toEqual({ user: { id: user.id } });
  });

  it('returns undefined for an unknown profile id', async () => {
    const result = await expertsRepository.findUserIdByProfileId(randomUUID());

    expect(result).toBeUndefined();
  });
});

// ── findUserIdsByProfileIds ──────────────────────────────────────────

describe('expertsRepository.findUserIdsByProfileIds', () => {
  it('maps multiple profile ids to their underlying user ids', async () => {
    const userA = await userFactory();
    const userB = await userFactory();
    const draftA = await expertDraftFactory({ userId: userA.id });
    const draftB = await expertDraftFactory({ userId: userB.id });

    const ids = await expertsRepository.findUserIdsByProfileIds([draftA.id, draftB.id]);

    expect(ids.sort()).toEqual([userA.id, userB.id].sort());
  });

  it('returns [] for an empty input array', async () => {
    const ids = await expertsRepository.findUserIdsByProfileIds([]);

    expect(ids).toEqual([]);
  });

  it('ignores unknown profile ids and returns only the resolved user ids', async () => {
    const user = await userFactory();
    const draft = await expertDraftFactory({ userId: user.id });

    const ids = await expertsRepository.findUserIdsByProfileIds([draft.id, randomUUID()]);

    expect(ids).toEqual([user.id]);
  });

  it('excludes a profile whose underlying user is soft-deleted', async () => {
    const liveUser = await userFactory();
    const deletedUser = await userFactory();
    const liveDraft = await expertDraftFactory({ userId: liveUser.id });
    const deletedDraft = await expertDraftFactory({ userId: deletedUser.id });
    await usersRepository.softDelete(deletedUser.id);

    const ids = await expertsRepository.findUserIdsByProfileIds([liveDraft.id, deletedDraft.id]);

    expect(ids).toEqual([liveUser.id]);
    expect(ids).not.toContain(deletedUser.id);
  });
});

// ── isUniqueViolation (pure narrowing helper) ────────────────────────

describe('isUniqueViolation', () => {
  it('returns false for non-object / null inputs', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('boom')).toBe(false);
  });

  it('detects a unique violation by SQLSTATE 23505 with no constraint filter', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('detects a unique violation by message when no code field is present', () => {
    expect(isUniqueViolation({ message: 'duplicate key value violates unique constraint' })).toBe(
      true
    );
  });

  it('returns false for a non-unique error', () => {
    expect(isUniqueViolation({ code: '23503', message: 'foreign key violation' })).toBe(false);
  });

  it('matches a specific constraint via constraint_name', () => {
    const err = {
      code: '23505',
      constraint_name: 'expert_user_vertical_idx',
      message: 'duplicate key value',
    };
    expect(isUniqueViolation(err, 'expert_user_vertical_idx')).toBe(true);
    expect(isUniqueViolation(err, 'expert_profiles_username_idx')).toBe(false);
  });

  it('falls back to matching the constraint name inside the message', () => {
    const err = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "expert_profiles_username_idx"',
    };
    expect(isUniqueViolation(err, 'expert_profiles_username_idx')).toBe(true);
  });

  it('ignores non-string message / constraint_name fields', () => {
    expect(isUniqueViolation({ code: '23505', message: 123, constraint_name: {} }, 'x')).toBe(
      false
    );
  });
});

// ── saveProfileStep resolve/load guards ──────────────────────────────

describe('expertsRepository.saveProfileStep guards', () => {
  const emptyWrite = { languages: [], industryIds: [] };

  it('throws when neither an expertProfileId nor a draftInput is supplied', async () => {
    await expect(
      expertsRepository.saveProfileStep(undefined, undefined, emptyWrite)
    ).rejects.toThrow('requires either an expertProfileId or a draftInput');
  });

  it('throws when the supplied expertProfileId does not exist', async () => {
    await expect(
      expertsRepository.saveProfileStep(randomUUID(), undefined, emptyWrite)
    ).rejects.toThrow('Expert profile not found');
  });
});

// ── syncCertifications standalone (self-wrapping, no executor) ────────

describe('expertsRepository.syncCertifications (standalone)', () => {
  it('self-wraps in a transaction; empty date/url fields persist as null', async () => {
    const draft = await expertDraftFactory();
    const vertical = await referenceDataRepository.getSalesforceVertical();
    const [cert] = await db
      .insert(certifications)
      .values({ verticalId: vertical.id, name: 'Admin Standalone', slug: uniq('admin-standalone') })
      .returning();
    if (!cert) throw new Error('Failed to seed certification');

    // Empty earnedAt/expiresAt/credentialUrl exercise the `|| null` coercions.
    await expertsRepository.syncCertifications(draft.id, [
      { certificationId: cert.id, earnedAt: '', expiresAt: '', credentialUrl: '' },
    ]);
    let rows = await db.query.expertCertifications.findMany({
      where: eq(expertCertifications.expertProfileId, draft.id),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.earnedAt).toBeNull();
    expect(rows[0]?.credentialUrl).toBeNull();

    // Empty array clears (covers the certs.length === 0 branch).
    await expertsRepository.syncCertifications(draft.id, []);
    rows = await db.query.expertCertifications.findMany({
      where: eq(expertCertifications.expertProfileId, draft.id),
    });
    expect(rows).toHaveLength(0);
  });
});

// ── findOrCreateDraft race / username-degradation paths ──────────────
// These branches are unreachable with a real DB in a single-connection
// integration harness: the ON CONFLICT (user_id, vertical_id) swallow + adopt,
// and the username-index retry loop. findOrCreateDraft accepts an executor (the
// same composition seam saveProfileStep uses), so we inject a scripted fake
// executor; the real test DB still backs the username pre-pick query.

type InsertOutcome = { throw?: unknown; returning?: ExpertProfile[] };

function fakeExecutor(opts: {
  findFirst: Array<ExpertProfile | undefined>;
  insert: InsertOutcome[];
}): Parameters<typeof expertsRepository.findOrCreateDraft>[1] {
  let f = 0;
  let i = 0;
  const exec = {
    query: { expertProfiles: { findFirst: () => Promise.resolve(opts.findFirst[f++]) } },
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: () => {
            const step = opts.insert[i++];
            if (step?.throw) return Promise.reject(step.throw);
            return Promise.resolve(step?.returning ?? []);
          },
        }),
      }),
    }),
  };
  return exec as unknown as Parameters<typeof expertsRepository.findOrCreateDraft>[1];
}

const profileRow = (id: string): ExpertProfile => ({ id }) as unknown as ExpertProfile;

const usernameViolation = (): unknown =>
  Object.assign(new Error('duplicate key value'), {
    code: '23505',
    constraint_name: 'expert_profiles_username_idx',
  });

const draftInput = (firstName: string, lastName: string) => ({
  userId: randomUUID(),
  verticalId: randomUUID(),
  type: 'freelancer' as const,
  firstName,
  lastName,
});

describe('expertsRepository.findOrCreateDraft (race + degradation paths)', () => {
  it('adopts the winning row when ON CONFLICT swallows a concurrent insert', async () => {
    const winner = profileRow(randomUUID());
    const exec = fakeExecutor({ findFirst: [undefined, winner], insert: [{ returning: [] }] });

    const result = await expertsRepository.findOrCreateDraft(draftInput('Race', 'Winner'), exec);

    expect(result.id).toBe(winner.id);
  });

  it('throws when the conflict is swallowed but no row is found on refetch', async () => {
    const exec = fakeExecutor({ findFirst: [undefined, undefined], insert: [{ returning: [] }] });

    await expect(
      expertsRepository.findOrCreateDraft(draftInput('Patho', 'Logical'), exec)
    ).rejects.toThrow('Failed to find or create draft profile');
  });

  it('retries on a username-index collision and succeeds with the next username', async () => {
    const created = profileRow(randomUUID());
    const exec = fakeExecutor({
      findFirst: [undefined],
      insert: [{ throw: usernameViolation() }, { returning: [created] }],
    });

    const result = await expertsRepository.findOrCreateDraft(draftInput('Retry', 'Once'), exec);

    expect(result.id).toBe(created.id);
  });

  it('degrades to a null username after exhausting username retries', async () => {
    const created = profileRow(randomUUID());
    const exec = fakeExecutor({
      findFirst: [undefined],
      insert: [
        { throw: usernameViolation() },
        { throw: usernameViolation() },
        { throw: usernameViolation() },
        { throw: usernameViolation() },
        { returning: [created] },
      ],
    });

    const result = await expertsRepository.findOrCreateDraft(
      draftInput('Exhaust', 'Retries'),
      exec
    );

    expect(result.id).toBe(created.id);
  });

  it('rethrows a non-username unique violation without retrying', async () => {
    const otherViolation = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint_name: 'some_other_idx',
    });
    const exec = fakeExecutor({ findFirst: [undefined], insert: [{ throw: otherViolation }] });

    await expect(
      expertsRepository.findOrCreateDraft(draftInput('Other', 'Violation'), exec)
    ).rejects.toThrow('duplicate key value');
  });
});
