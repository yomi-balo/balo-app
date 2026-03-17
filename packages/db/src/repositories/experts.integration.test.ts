import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../client';
import { expertIndustries, expertLanguages, industries, languages } from '../schema';
import { userFactory, expertDraftFactory } from '../test/factories';
import { expertsRepository } from './experts';
import { referenceDataRepository } from './reference-data';

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

    // Set hourlyRate
    await expertsRepository.updateProfile(draft.id, {
      hourlyRate: 150,
    });

    // Update only headline — hourlyRate should remain
    await expertsRepository.updateProfile(draft.id, {
      headline: 'New headline',
    });

    const updated = await expertsRepository.findProfileById(draft.id);
    expect(updated?.headline).toBe('New headline');
    expect(updated?.hourlyRate).toBe(150);
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
