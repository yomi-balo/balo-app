import { describe, it, expect } from 'vitest';
import { userFactory, expertFactory, expertDraftFactory, meetingFactory } from './index';

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

  it('meetingFactory creates a scheduled meeting with ONE case context row', async () => {
    const { meeting, contexts, caseEngagementId } = await meetingFactory();

    expect(meeting.id).toBeDefined();
    expect(meeting.status).toBe('scheduled');
    expect(meeting.outcome).toBeNull();
    expect(meeting.scheduledStart.getTime()).toBeLessThan(meeting.scheduledEnd.getTime());

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.contextType).toBe('case');
    expect(contexts[0]?.contextId).toBe(caseEngagementId);
  });
});
