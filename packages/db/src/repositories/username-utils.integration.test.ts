import { describe, it, expect } from 'vitest';
import { userFactory, expertDraftFactory } from '../test/factories';
import { expertsRepository } from './experts';
import { referenceDataRepository } from './reference-data';

// ── findUsernamesWithPrefix ─────────────────────────────────────

describe('expertsRepository.findUsernamesWithPrefix', () => {
  it('returns empty array when no matching usernames exist', async () => {
    const result = await expertsRepository.findUsernamesWithPrefix('nonexistent-user');

    expect(result).toEqual([]);
  });

  it('returns matching usernames when experts with that prefix exist', async () => {
    // Create two experts and set specific usernames
    const draft1 = await expertDraftFactory({ firstName: 'Prefix', lastName: 'Alpha' });
    await expertsRepository.updateProfile(draft1.id, { username: 'john-doe' });

    const draft2 = await expertDraftFactory({ firstName: 'Prefix', lastName: 'Beta' });
    await expertsRepository.updateProfile(draft2.id, { username: 'john-doe-2' });

    const result = await expertsRepository.findUsernamesWithPrefix('john-doe');

    expect(result).toHaveLength(2);
    expect(result).toContain('john-doe');
    expect(result).toContain('john-doe-2');
  });

  it('excludes usernames that do not match the prefix', async () => {
    const draft1 = await expertDraftFactory({ firstName: 'Exclude', lastName: 'Alpha' });
    await expertsRepository.updateProfile(draft1.id, { username: 'john-doe' });

    const draft2 = await expertDraftFactory({ firstName: 'Exclude', lastName: 'Beta' });
    await expertsRepository.updateProfile(draft2.id, { username: 'jane-smith' });

    const result = await expertsRepository.findUsernamesWithPrefix('john-doe');

    expect(result).toContain('john-doe');
    expect(result).not.toContain('jane-smith');
  });

  it('escapes SQL wildcard % in the base so it is treated as a literal character', async () => {
    // Create an expert with a literal % in the username
    const draft1 = await expertDraftFactory({ firstName: 'Wildcard', lastName: 'Pct1' });
    await expertsRepository.updateProfile(draft1.id, { username: 'john%doe' });

    // Create another expert that would falsely match if % were unescaped
    const draft2 = await expertDraftFactory({ firstName: 'Wildcard', lastName: 'Pct2' });
    await expertsRepository.updateProfile(draft2.id, { username: 'johnXdoe-2' });

    // Search with prefix "john%doe" — if % were unescaped, the LIKE pattern
    // 'john%doe-%' would match 'johnXdoe-2' (% matches 'X'). With escaping,
    // only literal 'john%doe' and 'john%doe-*' should match.
    const result = await expertsRepository.findUsernamesWithPrefix('john%doe');
    expect(result).toContain('john%doe');
    expect(result).not.toContain('johnXdoe-2');
  });

  it('escapes SQL wildcard _ in the base so it is treated as a literal character', async () => {
    // Create an expert with a literal _ in the username
    const draft1 = await expertDraftFactory({ firstName: 'Wildcard', lastName: 'Under1' });
    await expertsRepository.updateProfile(draft1.id, { username: 'john_doe' });

    // Create another expert that would falsely match if _ were unescaped
    const draft2 = await expertDraftFactory({ firstName: 'Wildcard', lastName: 'Under2' });
    await expertsRepository.updateProfile(draft2.id, { username: 'johnxdoe-2' });

    // Search with prefix "john_doe" — if _ were unescaped, the LIKE pattern
    // 'john_doe-%' would match 'johnxdoe-2' (_ matches 'x'). With escaping,
    // only literal 'john_doe' and 'john_doe-*' should match.
    const result = await expertsRepository.findUsernamesWithPrefix('john_doe');
    expect(result).toContain('john_doe');
    expect(result).not.toContain('johnxdoe-2');
  });
});

// ── createDraft (end-to-end username generation) ────────────────

describe('expertsRepository.createDraft — username generation', () => {
  it('generates firstname-lastname when no collision exists', async () => {
    const draft = await expertDraftFactory({
      firstName: 'Unique',
      lastName: 'Person',
    });

    expect(draft.username).toBe('unique-person');
  });

  it('appends -2 suffix when the base slug is already taken', async () => {
    // First expert takes "collision-test"
    const first = await expertDraftFactory({
      firstName: 'Collision',
      lastName: 'Test',
    });
    expect(first.username).toBe('collision-test');

    // Second expert with same names should get "-2"
    const second = await expertDraftFactory({
      firstName: 'Collision',
      lastName: 'Test',
    });
    expect(second.username).toBe('collision-test-2');
  });

  it('appends -3 suffix when both base and -2 are taken', async () => {
    const first = await expertDraftFactory({
      firstName: 'Triple',
      lastName: 'Clash',
    });
    expect(first.username).toBe('triple-clash');

    const second = await expertDraftFactory({
      firstName: 'Triple',
      lastName: 'Clash',
    });
    expect(second.username).toBe('triple-clash-2');

    const third = await expertDraftFactory({
      firstName: 'Triple',
      lastName: 'Clash',
    });
    expect(third.username).toBe('triple-clash-3');
  });

  it('handles names with special characters correctly', async () => {
    const draft = await expertDraftFactory({
      firstName: "O'Brien",
      lastName: 'De La Cruz',
    });

    // Apostrophe and spaces become hyphens, consecutive hyphens collapsed
    expect(draft.username).toBe('o-brien-de-la-cruz');
  });

  it('sets username to null when lastName is null', async () => {
    // Bypass factory — its ?? operator discards explicit null overrides
    const user = await userFactory({ firstName: 'Solo', lastName: 'Ignored' });
    const vertical = await referenceDataRepository.getSalesforceVertical();

    const draft = await expertsRepository.createDraft({
      userId: user.id,
      verticalId: vertical.id,
      type: 'freelancer',
      firstName: 'Solo',
      lastName: null,
    });

    // generateBaseUsername returns null when lastName is null
    expect(draft.username).toBeNull();
  });
});
