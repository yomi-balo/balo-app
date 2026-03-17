import { describe, it, expect } from 'vitest';
import { userFactory, expertFactory, expertDraftFactory } from './index';

describe('Test factories', () => {
  it('userFactory creates a user with an id', async () => {
    const user = await userFactory();

    expect(user.id).toBeDefined();
    expect(user.email).toContain('@test.com');
    expect(user.firstName).toBe('Test');
  });

  it('expertDraftFactory creates a draft expert profile', async () => {
    const draft = await expertDraftFactory();

    expect(draft.id).toBeDefined();
    expect(draft.applicationStatus).toBe('draft');
    expect(draft.userId).toBeDefined();
    expect(draft.verticalId).toBeDefined();
  });

  it('expertFactory creates an approved expert profile', async () => {
    const expert = await expertFactory();

    expect(expert.id).toBeDefined();
    expect(expert.applicationStatus).toBe('approved');
    expect(expert.approvedAt).toBeDefined();
  });
});
