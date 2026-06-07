import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
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
} from '../schema';
import {
  userFactory,
  expertDraftFactory,
  expertFactory,
  searchExpertFactory,
} from '../test/factories';
import { expertsRepository } from './experts';
import { referenceDataRepository } from './reference-data';

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

    const [skill] = await db
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

    if (!skill || !supportType || !language || !industry || !certification || !agency) {
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
      skills: [{ productId: skill.id, supportTypeId: supportType.id, proficiency: 8 }],
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

    // skills (+ nested skill & supportType)
    expect(result?.skills).toHaveLength(1);
    expect(result?.skills[0]?.skill.name).toBe('Apex');
    expect(result?.skills[0]?.supportType.name).toBe('Implementation');
    expect(result?.skills[0]?.proficiency).toBe(8);

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
