import { describe, it, expect } from 'vitest';
import {
  agencyFactory,
  caseEngagementFactory,
  engagementFactory,
  userFactory,
  expertFactory,
  expertDraftFactory,
  meetingFactory,
} from './index';
import { expertsRepository } from '../../repositories/experts';

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

  it("engagementFactory and caseEngagementFactory pin the profile's agency by default", async () => {
    const expert = await expertDraftFactory();
    const agency = await agencyFactory();
    await expertsRepository.linkAgency(expert.id, agency.id);

    const project = await engagementFactory({ expertProfileId: expert.id });
    const kase = await caseEngagementFactory({ expertProfileId: expert.id });

    expect(project.engagement.deliveringAgencyId).toBe(agency.id);
    expect(kase.engagement.deliveringAgencyId).toBe(agency.id);
  });

  it('an independent expert gets a NULL pin, and values.deliveringAgencyId: null overrides an agency', async () => {
    const independent = await engagementFactory();
    expect(independent.engagement.deliveringAgencyId).toBeNull();

    const expert = await expertDraftFactory();
    const agency = await agencyFactory();
    await expertsRepository.linkAgency(expert.id, agency.id);

    const project = await engagementFactory({
      expertProfileId: expert.id,
      values: { deliveringAgencyId: null },
    });
    const kase = await caseEngagementFactory({
      expertProfileId: expert.id,
      values: { deliveringAgencyId: null },
    });

    expect(project.engagement.deliveringAgencyId).toBeNull();
    expect(kase.engagement.deliveringAgencyId).toBeNull();
  });
});
