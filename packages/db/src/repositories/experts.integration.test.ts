import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../client';
import {
  agencies,
  auditEvents,
  availabilityOverrides,
  availabilityRules,
  certifications,
  consultations,
  expertCertifications,
  expertCompetency,
  expertIndustries,
  expertLanguages,
  expertProfiles,
  industries,
  languages,
  products,
  supportTypes,
  users,
  workHistory,
  type ExpertProfile,
} from '../schema';
import {
  userFactory,
  expertDraftFactory,
  expertFactory,
  meetingFactory,
  searchExpertFactory,
  agencyFactory,
  engagementFactory,
  caseEngagementFactory,
} from '../test/factories';
import {
  EXPECTED_CONSULTATION_COUNT,
  UNCOUNTED_CONSULTATION_LABELS,
  seedConsultationCountMatrix,
} from '../test/helpers/consultation-count-matrix';
import { expertsRepository, isUniqueViolation } from './experts';
import { referenceDataRepository } from './reference-data';
import { reviewsRepository } from './reviews';
import { usersRepository } from './users';
import { auditEventsRepository } from './audit-events';
import { availabilityRulesRepository } from './availability-rules';
import { availabilityOverridesRepository } from './availability-overrides';

// Unique-suffix helper so inline taxonomy rows never collide across tests
// (slugs / language codes have unique indexes; transaction rollback resets
// data but a single test may seed several rows).
let taxonomySeq = 0;
function uniq(prefix: string): string {
  taxonomySeq++;
  return `${prefix}-${taxonomySeq}-${Date.now()}`;
}

/**
 * CHEAP-3 (fix round 1) — `UpdateProfileInput` no longer accepts `searchable`; the ONE writer
 * outside seeds is `expertSearchabilityRepository.applySearchable`'s conditional
 * compare-and-set. These fixtures legitimately need to set the flag directly (bypassing the
 * checklist derivation) to drive `findPublicProfileByUsername`'s visibility gate in isolation.
 */
async function setSearchableDirectly(expertProfileId: string, searchable: boolean): Promise<void> {
  await db.update(expertProfiles).set({ searchable }).where(eq(expertProfiles.id, expertProfileId));
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

  it('round-trips the timezone and three booking-rule columns (BAL-234)', async () => {
    const draft = await expertDraftFactory();

    await expertsRepository.updateProfile(draft.id, {
      timezone: 'Australia/Melbourne',
      bookingBufferBeforeMinutes: 15,
      bookingBufferAfterMinutes: 10,
      bookingMinimumNoticeMinutes: 120,
    });

    const updated = await expertsRepository.findProfileById(draft.id);
    expect(updated?.timezone).toBe('Australia/Melbourne');
    expect(updated?.bookingBufferBeforeMinutes).toBe(15);
    expect(updated?.bookingBufferAfterMinutes).toBe(10);
    expect(updated?.bookingMinimumNoticeMinutes).toBe(120);
  });

  it('a fresh draft has booking-rule defaults 0/0/0 and timezone UTC', async () => {
    const draft = await expertDraftFactory();

    const fresh = await expertsRepository.findProfileById(draft.id);
    expect(fresh?.timezone).toBe('UTC');
    expect(fresh?.bookingBufferBeforeMinutes).toBe(0);
    expect(fresh?.bookingBufferAfterMinutes).toBe(0);
    expect(fresh?.bookingMinimumNoticeMinutes).toBe(0);
  });

  /**
   * ⚠⚠ THE RATING COLUMNS HAVE EXACTLY ONE WRITER, AND THIS PROVES IT STRUCTURALLY.
   * `updateProfile` used to `.set({ ...data, updatedAt })`, which made the
   * `UpdateProfileInput` TYPE the only thing keeping `rating_average` / `rating_count` out
   * of this generic writer — and a type cannot do that job: TypeScript's excess-property
   * check fires on object LITERALS only, so a caller passing a VARIABLE carrying extra keys
   * wrote them straight through. The `SET` is now an explicit allow-list.
   *
   * The cast is the POINT of the test, not a workaround: it reproduces exactly what a
   * widened caller looks like at runtime, which is the only shape that can express this bug.
   * The rating columns must be untouched, and the legitimate field must still land.
   */
  it('IGNORES rating columns smuggled past the type — they keep one writer', async () => {
    const draft = await expertDraftFactory();
    await reviewsRepository.recomputeRatingAggregate(draft.id);

    const smuggled = {
      headline: 'Salesforce Architect',
      ratingAverage: '5.0',
      ratingCount: 99,
    } as unknown as Parameters<typeof expertsRepository.updateProfile>[1];
    await expertsRepository.updateProfile(draft.id, smuggled);

    const [row] = await db
      .select({
        headline: expertProfiles.headline,
        ratingAverage: expertProfiles.ratingAverage,
        ratingCount: expertProfiles.ratingCount,
      })
      .from(expertProfiles)
      .where(eq(expertProfiles.id, draft.id));

    // The legitimate field still writes — this is an allow-list, not a freeze.
    expect(row?.headline).toBe('Salesforce Architect');
    // …and the two rating columns are exactly what the recompute left.
    expect(row?.ratingAverage).toBeNull();
    expect(row?.ratingCount).toBe(0);
  });

  it('rejects a booking buffer beyond the CHECK bound (0..120)', async () => {
    const draft = await expertDraftFactory();

    // The migration CHECK (BETWEEN 0 AND 120) is the second line of defense behind
    // the API/action Zod. 200 exceeds it, so the DB write must fail.
    await expect(
      expertsRepository.updateProfile(draft.id, { bookingBufferBeforeMinutes: 200 })
    ).rejects.toThrow();
  });

  it('rejects a minimum-notice beyond the CHECK bound (0..20160)', async () => {
    const draft = await expertDraftFactory();

    await expect(
      expertsRepository.updateProfile(draft.id, { bookingMinimumNoticeMinutes: 20161 })
    ).rejects.toThrow();
  });
});

// ── findResolverSettings (BAL-234) ──────────────────────────────────

describe('expertsRepository.findResolverSettings', () => {
  it('returns the projected timezone + booking-rule shape', async () => {
    const draft = await expertDraftFactory();
    await expertsRepository.updateProfile(draft.id, {
      timezone: 'America/New_York',
      bookingBufferBeforeMinutes: 5,
      bookingBufferAfterMinutes: 30,
      bookingMinimumNoticeMinutes: 1440,
    });

    const settings = await expertsRepository.findResolverSettings(draft.id);

    expect(settings).toEqual({
      userId: draft.userId,
      timezone: 'America/New_York',
      bufferBeforeMinutes: 5,
      bufferAfterMinutes: 30,
      minimumNoticeMinutes: 1440,
      availableForWork: true,
    });
  });

  it('returns the defaults for a fresh draft', async () => {
    const draft = await expertDraftFactory();

    const settings = await expertsRepository.findResolverSettings(draft.id);

    expect(settings).toEqual({
      userId: draft.userId,
      timezone: 'UTC',
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minimumNoticeMinutes: 0,
      availableForWork: true,
    });
  });

  it('reports availableForWork=false for an expert who has paused new work', async () => {
    const draft = await expertDraftFactory();
    await expertsRepository.setAvailableForWork({
      expertProfileId: draft.id,
      availableForWork: false,
      actorUserId: draft.userId,
    });

    const settings = await expertsRepository.findResolverSettings(draft.id);

    expect(settings?.availableForWork).toBe(false);
  });

  it('returns null for an unknown profile id', async () => {
    const settings = await expertsRepository.findResolverSettings(randomUUID());

    expect(settings).toBeNull();
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
    await expertsRepository.updateProfile(draft.id, { username });
    await setSearchableDirectly(draft.id, true);

    const result = await expertsRepository.findPublicProfileByUsername(username);

    expect(result).toBeUndefined();
  });

  it('returns undefined when submitted but not approved', async () => {
    const username = uniq('submitted');
    const draft = await expertDraftFactory();
    await expertsRepository.updateProfile(draft.id, { username });
    await setSearchableDirectly(draft.id, true);
    await expertsRepository.submitApplication(draft.id);

    const result = await expertsRepository.findPublicProfileByUsername(username);

    expect(result).toBeUndefined();
  });

  it('returns undefined when approved but searchable is false', async () => {
    const username = uniq('not-searchable');
    // expertFactory approves but leaves searchable at its default (false).
    const expert = await expertFactory();
    await expertsRepository.updateProfile(expert.id, { username });
    await setSearchableDirectly(expert.id, false);

    const result = await expertsRepository.findPublicProfileByUsername(username);

    expect(result).toBeUndefined();
  });

  it('returns undefined when searchable is true but approvedAt is null (defensive)', async () => {
    const username = uniq('searchable-unapproved');
    const draft = await expertDraftFactory();
    await expertsRepository.updateProfile(draft.id, { username });
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

  /**
   * BAL-493 fix round 1 (security LOW) — the `users.deleted_at IS NULL` term.
   *
   * `searchable` and `approved_at` are PROFILE columns and `expert_profiles` has no
   * `deleted_at`, so soft-deleting the owning USER left this read fully passing: the profile
   * stayed approved + searchable and kept resolving by username. The slot route's visibility
   * read always filtered the joined user row; this read did not. It was unreachable in practice —
   * until BAL-493 pointed the public front page's curated spotlight at exactly this method.
   *
   * The first assertion is the one that matters: it establishes the profile IS otherwise
   * publicly visible, so the `undefined` after the soft delete can only be the new term.
   */
  it('returns undefined once the OWNING USER is soft-deleted, though the profile stays approved + searchable', async () => {
    const username = uniq('soft-deleted-user');
    const expert = await searchExpertFactory({ username, searchable: true });

    // Baseline: visible before the deletion, so the assertion below is not vacuous.
    await expect(expertsRepository.findPublicProfileByUsername(username)).resolves.toBeDefined();

    await usersRepository.softDelete(expert.userId);

    // The profile row is untouched — only the user was soft-deleted.
    const profileAfter = await db.query.expertProfiles.findFirst({
      where: eq(expertProfiles.id, expert.id),
      columns: { searchable: true, approvedAt: true },
    });
    expect(profileAfter?.searchable).toBe(true);
    expect(profileAfter?.approvedAt).not.toBeNull();

    await expect(expertsRepository.findPublicProfileByUsername(username)).resolves.toBeUndefined();
  });

  it('agrees with findPublicVisibility on the soft-deleted-user case (one visibility rule, not two)', async () => {
    const username = uniq('soft-delete-parity');
    const expert = await searchExpertFactory({ username, searchable: true });

    await usersRepository.softDelete(expert.userId);

    expect(await expertsRepository.findPublicVisibility(expert.id)).toBeNull();
    await expect(expertsRepository.findPublicProfileByUsername(username)).resolves.toBeUndefined();
  });

  // BAL-591 Part B — a suspended or inactive owner is not live (`userRowIsLive`), so the
  // profile 404s and drops off the front page's spotlight, which reads through this method.
  it.each(['suspended', 'inactive'] as const)(
    'returns undefined when the owning user is %s, and findPublicVisibility agrees',
    async (status) => {
      const username = uniq(`owner-${status}`);
      const expert = await searchExpertFactory({ username, searchable: true });
      await expect(expertsRepository.findPublicProfileByUsername(username)).resolves.toBeDefined();

      await db.update(users).set({ status }).where(eq(users.id, expert.userId));

      await expect(
        expertsRepository.findPublicProfileByUsername(username)
      ).resolves.toBeUndefined();
      expect(await expertsRepository.findPublicVisibility(expert.id)).toBeNull();
    }
  );

  it('stays visible while the expert has paused new work, reporting availableForWork=false', async () => {
    const username = uniq('paused-visible');
    const expert = await searchExpertFactory({ username, searchable: true });
    await expertsRepository.setAvailableForWork({
      expertProfileId: expert.id,
      availableForWork: false,
      actorUserId: expert.userId,
    });

    const result = await expertsRepository.findPublicProfileByUsername(username);

    expect(result?.id).toBe(expert.id);
    expect(result?.availableForWork).toBe(false);
  });

  it("eager-loads the expert's vertical name and slug", async () => {
    const username = uniq('with-vertical');
    await searchExpertFactory({ username, searchable: true });
    const salesforce = await referenceDataRepository.getSalesforceVertical();

    const result = await expertsRepository.findPublicProfileByUsername(username);

    expect(result?.vertical).toEqual({ name: salesforce.name, slug: salesforce.slug });
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

  it('counts ONLY delivered consultations in consultationCount (the hero stat)', async () => {
    // BAL-428 CRITICAL 2 — the profile hero half of the shared count expression. The matrix
    // (`test/helpers/consultation-count-matrix.ts`) is deliberately shared with
    // `expert-search.integration.test.ts`: one SQL expression feeds both surfaces so that
    // they can never disagree, and two hand-maintained fixtures would defeat that.
    const user = await userFactory();
    const username = uniq('consult-count');
    const expert = await searchExpertFactory({
      userId: user.id,
      username,
      searchable: true,
    });

    await seedConsultationCountMatrix(expert.id);

    const result = await expertsRepository.findPublicProfileByUsername(username);
    // Only the two `ended` + `completed` rows. Everything in the message below has a live
    // `confirmed` projection row and WOULD have counted before the `meetings` join landed.
    expect(
      result?.consultationCount,
      `hero stat must exclude: ${UNCOUNTED_CONSULTATION_LABELS.join('; ')}`
    ).toBe(EXPECTED_CONSULTATION_COUNT);
    expect(EXPECTED_CONSULTATION_COUNT).toBe(2);
  });

  it('a FUTURE booking alone leaves the expert reading as NEW (zero sessions)', async () => {
    // The self-inflation case, isolated: absence of this number is what renders an expert as
    // "New expert", so a single client-side booking must not flip that badge off.
    const user = await userFactory();
    const username = uniq('consult-future');
    const expert = await searchExpertFactory({ userId: user.id, username, searchable: true });
    const { meeting } = await meetingFactory({
      contexts: [],
      values: {
        scheduledStart: new Date(Date.now() + 7 * 24 * 3_600_000),
        scheduledEnd: new Date(Date.now() + 7 * 24 * 3_600_000 + 3_600_000),
        status: 'scheduled',
      },
    });
    await db.insert(consultations).values({
      meetingId: meeting.id,
      expertProfileId: expert.id,
      startAt: meeting.scheduledStart,
      endAt: meeting.scheduledEnd,
      status: 'confirmed',
    });

    const result = await expertsRepository.findPublicProfileByUsername(username);
    expect(result?.consultationCount).toBe(0);
  });

  it('reports a zero consultationCount when the expert has no consultations', async () => {
    const user = await userFactory();
    const username = uniq('consult-zero');
    await searchExpertFactory({ userId: user.id, username, searchable: true });

    const result = await expertsRepository.findPublicProfileByUsername(username);
    expect(result?.consultationCount).toBe(0);
  });
});

// ── findPublicVisibility (BAL-236 / BAL-591) ─────────────────────────────

describe('expertsRepository.findPublicVisibility', () => {
  it('visible and available for approved + searchable with a live owner', async () => {
    const expert = await searchExpertFactory({ username: uniq('visible'), searchable: true });

    expect(await expertsRepository.findPublicVisibility(expert.id)).toEqual({
      availableForWork: true,
    });
  });

  it('stays visible while paused, reporting availableForWork=false', async () => {
    const expert = await searchExpertFactory({ username: uniq('paused'), searchable: true });
    await expertsRepository.setAvailableForWork({
      expertProfileId: expert.id,
      availableForWork: false,
      actorUserId: expert.userId,
    });

    expect(await expertsRepository.findPublicVisibility(expert.id)).toEqual({
      availableForWork: false,
    });
  });

  it('null when searchable is false', async () => {
    // expertFactory approves but leaves searchable at its default (false).
    const expert = await expertFactory();

    expect(await expertsRepository.findPublicVisibility(expert.id)).toBeNull();
  });

  it('null when approvedAt is null', async () => {
    const draft = await expertDraftFactory();
    await setSearchableDirectly(draft.id, true);

    expect(await expertsRepository.findPublicVisibility(draft.id)).toBeNull();
  });

  /**
   * ⚠ THE OWNING USER'S SOFT DELETE, NOT THE PROFILE'S — `expert_profiles` has no `deleted_at`.
   * `searchable` lives on the profile, so without this term a deleted person's live calendar
   * complement would keep being published by a public, unauthenticated endpoint.
   */
  it('null once the owning user is soft-deleted, even with searchable still true', async () => {
    const user = await userFactory();
    const expert = await searchExpertFactory({
      userId: user.id,
      username: uniq('visible-then-deleted'),
      searchable: true,
    });
    expect(await expertsRepository.findPublicVisibility(expert.id)).not.toBeNull();

    await usersRepository.softDelete(user.id);

    expect(await expertsRepository.findPublicVisibility(expert.id)).toBeNull();
  });

  it('null for an unknown id', async () => {
    expect(
      await expertsRepository.findPublicVisibility('00000000-0000-4000-8000-000000000000')
    ).toBeNull();
  });
});

// ── findNewWorkEligibility (BAL-588 / BAL-591) ──────────────────────────

describe('expertsRepository.findNewWorkEligibility', () => {
  it('eligible for an approved, searchable, available expert with a live owner', async () => {
    const expert = await searchExpertFactory({ username: uniq('eligible'), searchable: true });

    expect(await expertsRepository.findNewWorkEligibility(expert.id)).toEqual({
      eligible: true,
    });
  });

  it('not_found for an unknown id', async () => {
    expect(
      await expertsRepository.findNewWorkEligibility('00000000-0000-4000-8000-000000000000')
    ).toEqual({ eligible: false, reason: 'not_found' });
  });

  it('owner_not_live once the owning user is soft-deleted', async () => {
    const user = await userFactory();
    const expert = await searchExpertFactory({
      userId: user.id,
      username: uniq('deleted-owner'),
      searchable: true,
    });
    await usersRepository.softDelete(user.id);

    expect(await expertsRepository.findNewWorkEligibility(expert.id)).toEqual({
      eligible: false,
      reason: 'owner_not_live',
    });
  });

  it('owner_not_live when the owning user is suspended', async () => {
    const user = await userFactory();
    const expert = await searchExpertFactory({
      userId: user.id,
      username: uniq('suspended-owner'),
      searchable: true,
    });
    await db.update(users).set({ status: 'suspended' }).where(eq(users.id, user.id));

    expect(await expertsRepository.findNewWorkEligibility(expert.id)).toEqual({
      eligible: false,
      reason: 'owner_not_live',
    });
  });

  it('owner_not_live, not not_searchable, for a suspended owner whose profile is not searchable', async () => {
    const user = await userFactory();
    const expert = await searchExpertFactory({
      userId: user.id,
      username: uniq('suspended-unsearchable'),
      searchable: false,
    });
    await db.update(users).set({ status: 'suspended' }).where(eq(users.id, user.id));

    expect(await expertsRepository.findNewWorkEligibility(expert.id)).toEqual({
      eligible: false,
      reason: 'owner_not_live',
    });
  });

  it('not_approved for a draft, even when searchable', async () => {
    const draft = await expertDraftFactory();
    await setSearchableDirectly(draft.id, true);

    expect(await expertsRepository.findNewWorkEligibility(draft.id)).toEqual({
      eligible: false,
      reason: 'not_approved',
    });
  });

  it('not_searchable for an approved expert that is not searchable', async () => {
    const expert = await expertFactory();

    expect(await expertsRepository.findNewWorkEligibility(expert.id)).toEqual({
      eligible: false,
      reason: 'not_searchable',
    });
  });

  it('not_available when available_for_work is false', async () => {
    const expert = await searchExpertFactory({ username: uniq('unavailable'), searchable: true });
    await db
      .update(expertProfiles)
      .set({ availableForWork: false })
      .where(eq(expertProfiles.id, expert.id));

    expect(await expertsRepository.findNewWorkEligibility(expert.id)).toEqual({
      eligible: false,
      reason: 'not_available',
    });
  });
});

// ── setAvailableForWork (BAL-591) ───────────────────────────────────

const WORK_AVAILABILITY_ACTION = 'expert_work_availability.changed';

async function workAvailabilityAuditRows(
  expertProfileId: string
): Promise<(typeof auditEvents.$inferSelect)[]> {
  return db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.entityType, 'expert_profile'),
        eq(auditEvents.entityId, expertProfileId),
        eq(auditEvents.action, WORK_AVAILABILITY_ACTION)
      )
    );
}

async function availableForWorkOf(expertProfileId: string): Promise<boolean | undefined> {
  const row = await db.query.expertProfiles.findFirst({
    where: eq(expertProfiles.id, expertProfileId),
    columns: { availableForWork: true },
  });
  return row?.availableForWork;
}

describe('expertsRepository.setAvailableForWork', () => {
  it('pauses: flips the column and appends exactly one audit row with {from, to} and the actor', async () => {
    const expert = await searchExpertFactory({ username: uniq('pause'), searchable: true });

    const result = await expertsRepository.setAvailableForWork({
      expertProfileId: expert.id,
      availableForWork: false,
      actorUserId: expert.userId,
    });

    expect(result).toEqual({ changed: true });
    expect(await availableForWorkOf(expert.id)).toBe(false);
    const rows = await workAvailabilityAuditRows(expert.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({ from: true, to: false });
    expect(rows[0]?.actorUserId).toBe(expert.userId);
  });

  it('a write to the value already held changes nothing and appends no audit row', async () => {
    const expert = await searchExpertFactory({ username: uniq('noop'), searchable: true });

    const result = await expertsRepository.setAvailableForWork({
      expertProfileId: expert.id,
      availableForWork: true,
      actorUserId: expert.userId,
    });

    expect(result).toEqual({ changed: false });
    expect(await availableForWorkOf(expert.id)).toBe(true);
    expect(await workAvailabilityAuditRows(expert.id)).toHaveLength(0);
  });

  it('a repeated pause is idempotent: one audit row, not two', async () => {
    const expert = await searchExpertFactory({ username: uniq('double'), searchable: true });
    const input = { expertProfileId: expert.id, availableForWork: false, actorUserId: null };

    await expect(expertsRepository.setAvailableForWork(input)).resolves.toEqual({ changed: true });
    await expect(expertsRepository.setAvailableForWork(input)).resolves.toEqual({
      changed: false,
    });

    expect(await workAvailabilityAuditRows(expert.id)).toHaveLength(1);
  });

  it('an unknown profile id changes nothing', async () => {
    await expect(
      expertsRepository.setAvailableForWork({
        expertProfileId: randomUUID(),
        availableForWork: false,
        actorUserId: null,
      })
    ).resolves.toEqual({ changed: false });
  });

  it('pause then resume leaves weekly rules, date overrides and booking rules exactly as they were', async () => {
    const expert = await searchExpertFactory({ username: uniq('roundtrip'), searchable: true });
    await expertsRepository.updateProfile(expert.id, {
      timezone: 'Australia/Sydney',
      bookingBufferBeforeMinutes: 10,
      bookingBufferAfterMinutes: 15,
      bookingMinimumNoticeMinutes: 120,
    });
    await availabilityRulesRepository.replaceForExpert(expert.id, [
      { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
      { dayOfWeek: 3, startTime: '10:00', endTime: '14:00' },
    ]);
    await availabilityOverridesRepository.create({
      expertProfileId: expert.id,
      startDate: '2099-01-10',
      endDate: '2099-01-12',
      label: 'Conference',
    });

    const snapshot = async (): Promise<unknown> => ({
      settings: await expertsRepository.findResolverSettings(expert.id),
      rules: await db
        .select()
        .from(availabilityRules)
        .where(eq(availabilityRules.expertProfileId, expert.id)),
      overrides: await db
        .select()
        .from(availabilityOverrides)
        .where(eq(availabilityOverrides.expertProfileId, expert.id)),
    });
    const before = await snapshot();

    await expertsRepository.setAvailableForWork({
      expertProfileId: expert.id,
      availableForWork: false,
      actorUserId: expert.userId,
    });
    await expertsRepository.setAvailableForWork({
      expertProfileId: expert.id,
      availableForWork: true,
      actorUserId: expert.userId,
    });

    expect(await snapshot()).toEqual(before);
    const rows = await workAvailabilityAuditRows(expert.id);
    expect(rows.map((r) => r.metadata)).toEqual(
      expect.arrayContaining([
        { from: true, to: false },
        { from: false, to: true },
      ])
    );
    expect(rows).toHaveLength(2);
  });

  it('joins a caller-supplied transaction: a rollback there undoes the flip and its audit row', async () => {
    const expert = await searchExpertFactory({ username: uniq('caller-tx'), searchable: true });

    await expect(
      db.transaction(async (tx) => {
        const result = await expertsRepository.setAvailableForWork(
          { expertProfileId: expert.id, availableForWork: false, actorUserId: expert.userId },
          tx
        );
        expect(result).toEqual({ changed: true });
        throw new Error('caller rolls back');
      })
    ).rejects.toThrow('caller rolls back');

    expect(await availableForWorkOf(expert.id)).toBe(true);
    expect(await workAvailabilityAuditRows(expert.id)).toHaveLength(0);
  });

  it('rolls the column back when the audit insert fails (same transaction)', async () => {
    const expert = await searchExpertFactory({ username: uniq('audit-fail'), searchable: true });
    const spy = vi
      .spyOn(auditEventsRepository, 'record')
      .mockRejectedValueOnce(new Error('audit boom'));

    await expect(
      expertsRepository.setAvailableForWork({
        expertProfileId: expert.id,
        availableForWork: false,
        actorUserId: expert.userId,
      })
    ).rejects.toThrow('audit boom');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();

    expect(await availableForWorkOf(expert.id)).toBe(true);
    expect(await workAvailabilityAuditRows(expert.id)).toHaveLength(0);
  });

  it('a paused expert is not eligible for new work (not_available)', async () => {
    const expert = await searchExpertFactory({ username: uniq('paused-elig'), searchable: true });
    await expertsRepository.setAvailableForWork({
      expertProfileId: expert.id,
      availableForWork: false,
      actorUserId: expert.userId,
    });

    expect(await expertsRepository.findNewWorkEligibility(expert.id)).toEqual({
      eligible: false,
      reason: 'not_available',
    });
  });
});

// ── countWorkInFlight (BAL-591) ─────────────────────────────────────

const HOUR_MS = 3_600_000;

async function seedConsultation(
  expertProfileId: string,
  startAt: Date,
  overrides: { status?: 'confirmed' | 'cancelled'; deletedAt?: Date | null } = {}
): Promise<void> {
  const endAt = new Date(startAt.getTime() + HOUR_MS);
  const { meeting } = await meetingFactory({
    contexts: [],
    values: { scheduledStart: startAt, scheduledEnd: endAt },
  });
  await db.insert(consultations).values({
    meetingId: meeting.id,
    expertProfileId,
    startAt,
    endAt,
    status: overrides.status ?? 'confirmed',
    deletedAt: overrides.deletedAt ?? null,
  });
}

describe('expertsRepository.countWorkInFlight', () => {
  const NOW = new Date('2026-10-03T00:00:00.000Z');

  it('counts only future, confirmed, live consultations and active, live projects of THIS expert', async () => {
    const expert = await expertDraftFactory();
    const other = await expertDraftFactory();

    // Counted: two upcoming confirmed consultations (one starting exactly at `now`).
    await seedConsultation(expert.id, NOW);
    await seedConsultation(expert.id, new Date(NOW.getTime() + 48 * HOUR_MS));
    // Not counted: past, cancelled, soft-deleted, another expert's.
    await seedConsultation(expert.id, new Date(NOW.getTime() - 48 * HOUR_MS));
    await seedConsultation(expert.id, new Date(NOW.getTime() + 24 * HOUR_MS), {
      status: 'cancelled',
    });
    await seedConsultation(expert.id, new Date(NOW.getTime() + 72 * HOUR_MS), {
      deletedAt: new Date(),
    });
    await seedConsultation(other.id, new Date(NOW.getTime() + 24 * HOUR_MS));

    // Counted: one active project.
    await engagementFactory({ expertProfileId: expert.id });
    // Not counted: completed, cancelled, soft-deleted, a case, another expert's.
    await engagementFactory({
      expertProfileId: expert.id,
      projectValues: { deliveryStatus: 'completed' },
    });
    await engagementFactory({
      expertProfileId: expert.id,
      projectValues: { deliveryStatus: 'cancelled' },
    });
    await engagementFactory({ expertProfileId: expert.id, values: { deletedAt: new Date() } });
    await caseEngagementFactory({ expertProfileId: expert.id });
    await engagementFactory({ expertProfileId: other.id });

    expect(await expertsRepository.countWorkInFlight(expert.id, NOW)).toEqual({
      upcomingConsultations: 2,
      activeProjects: 1,
    });
  });

  it('both zero when nothing is in flight', async () => {
    const expert = await expertDraftFactory();

    expect(await expertsRepository.countWorkInFlight(expert.id, NOW)).toEqual({
      upcomingConsultations: 0,
      activeProjects: 0,
    });
  });

  it('both zero for an unknown profile id', async () => {
    expect(await expertsRepository.countWorkInFlight(randomUUID(), NOW)).toEqual({
      upcomingConsultations: 0,
      activeProjects: 0,
    });
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
  it('starts the schedule timezone from the one the user chose at onboarding', async () => {
    const user = await userFactory({ timezone: 'Australia/Melbourne' });
    const vertical = await referenceDataRepository.getSalesforceVertical();

    const draft = await expertsRepository.findOrCreateDraft({
      userId: user.id,
      verticalId: vertical.id,
      type: 'freelancer',
    });

    expect(draft.timezone).toBe('Australia/Melbourne');
  });

  it('falls back to UTC when the user never chose a timezone', async () => {
    const user = await userFactory({ timezone: null });
    const vertical = await referenceDataRepository.getSalesforceVertical();

    const draft = await expertsRepository.findOrCreateDraft({
      userId: user.id,
      verticalId: vertical.id,
      type: 'freelancer',
    });

    expect(draft.timezone).toBe('UTC');
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

// ── findPendingApplicationByUserId ───────────────────────────────────

describe('expertsRepository.findPendingApplicationByUserId', () => {
  it('returns the submission time of a submitted application', async () => {
    const user = await userFactory();
    const draft = await expertDraftFactory({ userId: user.id });
    const submitted = await expertsRepository.submitApplication(draft.id);

    const result = await expertsRepository.findPendingApplicationByUserId(user.id);

    expect(result).toEqual({ submittedAt: submitted.submittedAt });
  });

  it('counts an application staff have moved to under_review as still pending', async () => {
    const user = await userFactory();
    const draft = await expertDraftFactory({ userId: user.id });
    await expertsRepository.submitApplication(draft.id);
    await db
      .update(expertProfiles)
      .set({ applicationStatus: 'under_review' })
      .where(eq(expertProfiles.id, draft.id));

    const result = await expertsRepository.findPendingApplicationByUserId(user.id);

    expect(result?.submittedAt).toBeInstanceOf(Date);
  });

  it('returns undefined for a draft that was never submitted', async () => {
    const user = await userFactory();
    await expertDraftFactory({ userId: user.id });

    expect(await expertsRepository.findPendingApplicationByUserId(user.id)).toBeUndefined();
  });

  it.each(['approved', 'rejected'] as const)(
    'returns undefined once the application is %s',
    async (status) => {
      const user = await userFactory();
      const draft = await expertDraftFactory({ userId: user.id });
      await expertsRepository.submitApplication(draft.id);
      await db
        .update(expertProfiles)
        .set({ applicationStatus: status })
        .where(eq(expertProfiles.id, draft.id));

      expect(await expertsRepository.findPendingApplicationByUserId(user.id)).toBeUndefined();
    }
  );

  it("never returns another user's pending application", async () => {
    const applicant = await userFactory();
    const other = await userFactory();
    const draft = await expertDraftFactory({ userId: applicant.id });
    await expertsRepository.submitApplication(draft.id);

    expect(await expertsRepository.findPendingApplicationByUserId(other.id)).toBeUndefined();
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
    // The owner's timezone read — no user row, so the draft falls back to UTC.
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
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

describe('expertsRepository.findDisplayProfileById — the PROJECTED party-card read (BAL-388)', () => {
  /**
   * ⚠ BAL-422 WIDENED THIS FROM SIX COLUMNS TO EIGHT (`ratingAverage` + `ratingCount`), and the
   * EXHAUSTIVE key-set is the point — it is what makes the widening a deliberate, reviewed act
   * rather than something a careless `select` could smuggle in. The concealment rationale is
   * untouched: the two additions are display aggregates a client already sees on the expert's
   * public card, while `rateCents` (the UN-MARKED-UP consultant rate) and the vendor ids stay
   * structurally absent.
   */
  it('returns eight display columns and NEVER rateCents / stripeConnectId / cronofyUserId', async () => {
    const expert = await expertFactory();
    await db
      .update(expertProfiles)
      .set({ rateCents: 25_000, stripeConnectId: 'acct_secret' })
      .where(eq(expertProfiles.id, expert.id));

    const row = await expertsRepository.findDisplayProfileById(expert.id);

    if (row === undefined) throw new Error('expected a display row');
    // rateCents is the UN-MARKED-UP consultant rate; the client lens already carries the all-in
    // charge, so a row holding both would hand the client the Balo margin.
    expect(Object.keys(row).sort()).toEqual([
      'agencyId',
      'headline',
      'id',
      'ratingAverage',
      'ratingCount',
      'type',
      'userId',
      'username',
    ]);
    expect(row).not.toHaveProperty('rateCents');
    expect(row).not.toHaveProperty('stripeConnectId');
    expect(row).not.toHaveProperty('cronofyUserId');
  });

  /**
   * ⚠ THE `numeric` → `number` PARSE HAPPENS IN THE REPOSITORY, and this is the only test that
   * can prove it against a REAL Postgres. Drizzle types `rating_average` as `string` and the
   * driver really does hand back `'4.3'`; a pass-through would put a string into a
   * `number | null` field and every `.toFixed(1)` downstream would throw at runtime while
   * typechecking clean.
   */
  it('parses rating_average from the numeric STRING into a number', async () => {
    const expert = await expertFactory();
    await db
      .update(expertProfiles)
      .set({ ratingAverage: '4.3', ratingCount: 2 })
      .where(eq(expertProfiles.id, expert.id));

    const row = await expertsRepository.findDisplayProfileById(expert.id);

    expect(row?.ratingAverage).toBe(4.3);
    expect(typeof row?.ratingAverage).toBe('number');
    expect(row?.ratingCount).toBe(2);
  });

  /** ⚠ NULL MEANS NO REVIEWS — never coalesced to 0, which would fabricate a bad score. */
  it('returns a null rating as null, never as 0, for an unrated expert', async () => {
    const expert = await expertFactory();

    const row = await expertsRepository.findDisplayProfileById(expert.id);

    expect(row?.ratingAverage).toBeNull();
    expect(row?.ratingCount).toBe(0);
  });

  it('returns undefined for an unknown profile id', async () => {
    await expect(expertsRepository.findDisplayProfileById(randomUUID())).resolves.toBeUndefined();
  });
});

/**
 * BAL-478 — the booking funding pre-check's narrow rate read. The raw-rate assertion below is
 * what makes "no markup in `packages/db`" a real, provable claim rather than a restatement of
 * the docblock: it asserts the EXACT seeded cents, not merely a non-null number.
 */
describe('expertsRepository.findRateCentsById (BAL-478)', () => {
  it('returns the raw, un-marked-up rate for a seeded profile', async () => {
    const expert = await expertFactory();
    await db
      .update(expertProfiles)
      .set({ rateCents: 30_000 })
      .where(eq(expertProfiles.id, expert.id));

    const row = await expertsRepository.findRateCentsById(expert.id);

    expect(row).toEqual({ rateCents: 30_000 });
  });

  it('returns { rateCents: null } for a rate-less profile', async () => {
    const expert = await expertFactory();

    const row = await expertsRepository.findRateCentsById(expert.id);

    expect(row).toEqual({ rateCents: null });
  });

  it('returns undefined for an unknown profile id', async () => {
    await expect(expertsRepository.findRateCentsById(randomUUID())).resolves.toBeUndefined();
  });
});

/**
 * BAL-548 / ADR-1055 — the `expert.application_pending` finder read.
 *
 * ⚠ `expert_profiles` HAS NO `deleted_at`, so there is no soft-deleted-profile case to
 * exclude here; the soft-delete case this suite CAN express is a soft-deleted USER, which the
 * INNER JOIN drops.
 */
describe('expertsRepository.listPendingApplicationsForAlerts', () => {
  /** A submitted (undecided) application, with a chosen `submitted_at`. */
  async function seedSubmitted(submittedAt: Date, overrides: { agencyId?: string } = {}) {
    const draft = await expertDraftFactory();
    await expertsRepository.submitApplication(draft.id);
    // ⚠ `submitted_at` is stamped with a JS `new Date()`, so every row in one test lands
    // within the same millisecond band; the ordering assertion needs an explicit anchor.
    await db
      .update(expertProfiles)
      .set({ submittedAt, agencyId: overrides.agencyId ?? null })
      .where(eq(expertProfiles.id, draft.id));
    return draft;
  }

  it('returns undecided applications OLDEST SUBMISSION FIRST, with the person and agency named', async () => {
    const agency = await agencyFactory();
    const older = await seedSubmitted(new Date('2026-01-01T00:00:00.000Z'), {
      agencyId: agency.id,
    });
    const newer = await seedSubmitted(new Date('2026-01-02T00:00:00.000Z'));

    const rows = await expertsRepository.listPendingApplicationsForAlerts(
      new Date('2026-02-01T00:00:00.000Z'),
      50
    );
    const mine = rows.filter((row) => [older.id, newer.id].includes(row.expertProfileId));

    expect(mine.map((row) => row.expertProfileId)).toEqual([older.id, newer.id]);
    const [first, second] = mine;
    expect(first?.applicationStatus).toBe('submitted');
    expect(first?.userFirstName).not.toBeNull();
    expect(first?.agencyName).toBe(agency.name);
    // An independent applicant has NO agency — that is the shape, not a missing row.
    expect(second?.agencyName).toBeNull();
  });

  it('excludes draft, approved and never-submitted applications', async () => {
    const draft = await expertDraftFactory();
    const approved = await expertFactory();
    const pending = await seedSubmitted(new Date('2026-01-01T00:00:00.000Z'));

    const rows = await expertsRepository.listPendingApplicationsForAlerts(
      new Date('2026-02-01T00:00:00.000Z'),
      50
    );
    const ids = rows.map((row) => row.expertProfileId);

    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(approved.id);
  });

  it('excludes an application whose USER was soft-deleted', async () => {
    const pending = await seedSubmitted(new Date('2026-01-01T00:00:00.000Z'));
    const [profile] = await db
      .select({ userId: expertProfiles.userId })
      .from(expertProfiles)
      .where(eq(expertProfiles.id, pending.id));
    if (profile === undefined) {
      throw new Error('expected the seeded profile');
    }
    await usersRepository.softDelete(profile.userId);

    const rows = await expertsRepository.listPendingApplicationsForAlerts(
      new Date('2026-02-01T00:00:00.000Z'),
      50
    );

    expect(rows.map((row) => row.expertProfileId)).not.toContain(pending.id);
  });

  it('the cutoff excludes a too-recent submission, and the limit bounds the batch', async () => {
    const old = await seedSubmitted(new Date('2026-01-01T00:00:00.000Z'));
    const recent = await seedSubmitted(new Date('2026-01-10T00:00:00.000Z'));

    const beforeCutoff = await expertsRepository.listPendingApplicationsForAlerts(
      new Date('2026-01-05T00:00:00.000Z'),
      50
    );
    expect(beforeCutoff.map((row) => row.expertProfileId)).toContain(old.id);
    expect(beforeCutoff.map((row) => row.expertProfileId)).not.toContain(recent.id);

    const bounded = await expertsRepository.listPendingApplicationsForAlerts(
      new Date('2026-02-01T00:00:00.000Z'),
      1
    );
    expect(bounded).toHaveLength(1);
  });
});

// ── BAL-593 — self-rating, projection, executor composition and the settings cert lock ──

async function seedCompetencyTaxonomy(): Promise<{
  productA: string;
  productB: string;
  supportX: string;
  supportY: string;
}> {
  const vertical = await referenceDataRepository.getSalesforceVertical();
  const productRows = await db
    .insert(products)
    .values([
      { verticalId: vertical.id, name: 'Sales Cloud', slug: uniq('sales') },
      { verticalId: vertical.id, name: 'Service Cloud', slug: uniq('service') },
    ])
    .returning({ id: products.id });
  const supportRows = await db
    .insert(supportTypes)
    .values([
      { verticalId: vertical.id, name: 'Build', slug: uniq('build') },
      { verticalId: vertical.id, name: 'Advise', slug: uniq('advise') },
    ])
    .returning({ id: supportTypes.id });
  const [productA, productB] = productRows.map((r) => r.id);
  const [supportX, supportY] = supportRows.map((r) => r.id);
  if (
    productA === undefined ||
    productB === undefined ||
    supportX === undefined ||
    supportY === undefined
  ) {
    throw new Error('seedCompetencyTaxonomy: insert returned too few rows');
  }
  return { productA, productB, supportX, supportY };
}

async function readCompetencyCell(
  expertProfileId: string,
  productId: string,
  supportTypeId: string
): Promise<{ proficiency: number; selfProficiency: number | null } | undefined> {
  const [row] = await db
    .select({
      proficiency: expertCompetency.proficiency,
      selfProficiency: expertCompetency.selfProficiency,
    })
    .from(expertCompetency)
    .where(
      and(
        eq(expertCompetency.expertProfileId, expertProfileId),
        eq(expertCompetency.productId, productId),
        eq(expertCompetency.supportTypeId, supportTypeId)
      )
    );
  return row;
}

describe('expertsRepository applicant writers — §H7 the self-rating', () => {
  it('syncProducts inserts each new cell at proficiency 0 and selfProficiency 0', async () => {
    const draft = await expertDraftFactory();
    const t = await seedCompetencyTaxonomy();

    await expertsRepository.syncProducts(draft.id, [t.productA], [t.supportX, t.supportY]);

    expect(await readCompetencyCell(draft.id, t.productA, t.supportX)).toEqual({
      proficiency: 0,
      selfProficiency: 0,
    });
    expect(await readCompetencyCell(draft.id, t.productA, t.supportY)).toEqual({
      proficiency: 0,
      selfProficiency: 0,
    });
  });

  it('updateCompetencyProficiency writes the self-rating on insert and on update', async () => {
    const draft = await expertDraftFactory();
    const t = await seedCompetencyTaxonomy();
    await expertsRepository.syncProducts(draft.id, [t.productA], [t.supportX]);

    await expertsRepository.updateCompetencyProficiency(draft.id, [
      // Conflict arm: the cell exists from syncProducts.
      { productId: t.productA, supportTypeId: t.supportX, proficiency: 7 },
      // Insert arm: no such cell yet.
      { productId: t.productB, supportTypeId: t.supportY, proficiency: 4 },
    ]);

    expect(await readCompetencyCell(draft.id, t.productA, t.supportX)).toEqual({
      proficiency: 7,
      selfProficiency: 7,
    });
    expect(await readCompetencyCell(draft.id, t.productB, t.supportY)).toEqual({
      proficiency: 4,
      selfProficiency: 4,
    });
  });
});

describe('expertsRepository reads — §H6 the self-rating stays off non-staff reads', () => {
  it('the public, settings and applicant reads carry no selfProficiency key; the staff read does', async () => {
    const username = uniq('self-rating');
    const expert = await searchExpertFactory({ username, searchable: true });
    const t = await seedCompetencyTaxonomy();
    await expertsRepository.updateCompetencyProficiency(expert.id, [
      { productId: t.productA, supportTypeId: t.supportX, proficiency: 6 },
    ]);
    await db
      .update(expertCompetency)
      .set({ proficiency: 3 })
      .where(eq(expertCompetency.expertProfileId, expert.id));

    const publicProfile = await expertsRepository.findPublicProfileByUsername(username);
    const settings = await expertsRepository.findProfileForSettings(expert.id);
    const application = await expertsRepository.findApplicationWithRelations(expert.id);
    const staff = await expertsRepository.findApplicationForStaffReview(expert.id);

    const reads = [publicProfile?.competencies, settings?.competencies, application?.competencies];
    for (const competencies of reads) {
      const [cell] = competencies ?? [];
      expect(cell).toBeDefined();
      expect(cell?.proficiency).toBe(3);
      expect(cell).not.toHaveProperty('selfProficiency');
    }
    expect(staff?.competencies[0]).not.toHaveProperty('selfProficiency');
    expect(staff?.selfRatings).toEqual([
      { productId: t.productA, supportTypeId: t.supportX, selfProficiency: 6 },
    ]);
  });
});

describe('expertsRepository applicant writers — §executor composition', () => {
  it('the five step writers compose under a parent transaction, so its rollback leaves nothing', async () => {
    const draft = await expertDraftFactory();
    const t = await seedCompetencyTaxonomy();
    const vertical = await referenceDataRepository.getSalesforceVertical();
    const [cert] = await db
      .insert(certifications)
      .values({ verticalId: vertical.id, name: 'Composed', slug: uniq('composed') })
      .returning();
    if (!cert) throw new Error('Failed to seed certification');

    await expect(
      db.transaction(async (tx) => {
        await expertsRepository.saveProfileStep(
          draft.id,
          undefined,
          { projectCountMin: 42, languages: [], industryIds: [] },
          tx
        );
        await expertsRepository.syncProducts(draft.id, [t.productA], [t.supportX], tx);
        await expertsRepository.updateCompetencyProficiency(
          draft.id,
          [{ productId: t.productB, supportTypeId: t.supportY, proficiency: 5 }],
          tx
        );
        await expertsRepository.saveCertificationsStep(
          draft.id,
          'https://trailblazer.me/id/composed',
          [{ certificationId: cert.id }],
          tx
        );
        await expertsRepository.syncWorkHistory(
          draft.id,
          [{ role: 'Lead', company: 'Contoso', startedAt: '2021-01-01', isCurrent: true }],
          tx
        );
        throw new Error('parent rollback');
      })
    ).rejects.toThrow('parent rollback');

    const profile = await expertsRepository.findProfileById(draft.id);
    expect(profile?.projectCountMin).toBeNull();
    expect(profile?.trailheadUrl).toBeNull();
    const competencyRows = await db
      .select({ id: expertCompetency.id })
      .from(expertCompetency)
      .where(eq(expertCompetency.expertProfileId, draft.id));
    expect(competencyRows).toHaveLength(0);
    const certRows = await db.query.expertCertifications.findMany({
      where: eq(expertCertifications.expertProfileId, draft.id),
    });
    expect(certRows).toHaveLength(0);
    const historyRows = await db.query.workHistory.findMany({
      where: eq(workHistory.expertProfileId, draft.id),
    });
    expect(historyRows).toHaveLength(0);
  });
});

describe('expertsRepository.saveSettingsCertifications — §settings-lock', () => {
  async function seedWithCerts(locked: boolean): Promise<{
    expertProfileId: string;
    certA: string;
    certB: string;
  }> {
    const expert = await expertFactory();
    const vertical = await referenceDataRepository.getSalesforceVertical();
    const certRows = await db
      .insert(certifications)
      .values([
        { verticalId: vertical.id, name: 'Lock A', slug: uniq('lock-a') },
        { verticalId: vertical.id, name: 'Lock B', slug: uniq('lock-b') },
      ])
      .returning({ id: certifications.id });
    const [certA, certB] = certRows.map((r) => r.id);
    if (certA === undefined || certB === undefined) throw new Error('seed failed');
    await expertsRepository.saveCertificationsStep(expert.id, 'https://trailblazer.me/id/before', [
      { certificationId: certA, earnedAt: '2022-02-02', credentialUrl: 'https://cred.example/a' },
    ]);
    await db
      .update(expertProfiles)
      .set({ skillsLocked: locked })
      .where(eq(expertProfiles.id, expert.id));
    return { expertProfileId: expert.id, certA, certB };
  }

  async function readCerts(
    expertProfileId: string
  ): Promise<{ certificationId: string; earnedAt: string | null; credentialUrl: string | null }[]> {
    return db
      .select({
        certificationId: expertCertifications.certificationId,
        earnedAt: expertCertifications.earnedAt,
        credentialUrl: expertCertifications.credentialUrl,
      })
      .from(expertCertifications)
      .where(eq(expertCertifications.expertProfileId, expertProfileId));
  }

  it('returns not_found for an unknown profile', async () => {
    expect(
      await expertsRepository.saveSettingsCertifications(randomUUID(), {
        certs: [],
        trailheadUrl: null,
      })
    ).toEqual({ outcome: 'not_found' });
  });

  it('unlocked: syncs the certifications and the trailhead URL', async () => {
    const seeded = await seedWithCerts(false);

    const result = await expertsRepository.saveSettingsCertifications(seeded.expertProfileId, {
      certs: [{ certificationId: seeded.certB }],
      trailheadUrl: 'https://trailblazer.me/id/after',
    });

    expect(result).toEqual({ outcome: 'saved' });
    expect((await readCerts(seeded.expertProfileId)).map((c) => c.certificationId)).toEqual([
      seeded.certB,
    ]);
    const profile = await expertsRepository.findProfileById(seeded.expertProfileId);
    expect(profile?.trailheadUrl).toBe('https://trailblazer.me/id/after');
  });

  it.each([
    ['adds', (s: { certA: string; certB: string }) => [s.certA, s.certB]],
    ['removes', () => []],
  ] as const)(
    'locked: refuses a set that %s a certification and writes nothing',
    async (_, ids) => {
      const seeded = await seedWithCerts(true);
      const before = await readCerts(seeded.expertProfileId);

      const result = await expertsRepository.saveSettingsCertifications(seeded.expertProfileId, {
        certs: ids(seeded).map((certificationId) => ({ certificationId })),
        trailheadUrl: 'https://trailblazer.me/id/after',
      });

      expect(result).toEqual({ outcome: 'locked' });
      expect(await readCerts(seeded.expertProfileId)).toEqual(before);
      const profile = await expertsRepository.findProfileById(seeded.expertProfileId);
      expect(profile?.trailheadUrl).toBe('https://trailblazer.me/id/before');
    }
  );

  it('locked, same set: saves the trailhead URL and leaves the retained certification untouched', async () => {
    const seeded = await seedWithCerts(true);

    const result = await expertsRepository.saveSettingsCertifications(seeded.expertProfileId, {
      certs: [{ certificationId: seeded.certA, earnedAt: '1999-01-01', credentialUrl: '' }],
      trailheadUrl: 'https://trailblazer.me/id/after',
    });

    expect(result).toEqual({ outcome: 'saved' });
    expect(await readCerts(seeded.expertProfileId)).toEqual([
      {
        certificationId: seeded.certA,
        earnedAt: '2022-02-02',
        credentialUrl: 'https://cred.example/a',
      },
    ]);
    const profile = await expertsRepository.findProfileById(seeded.expertProfileId);
    expect(profile?.trailheadUrl).toBe('https://trailblazer.me/id/after');
  });
});
