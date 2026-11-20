import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockFindRelationship } = vi.hoisted(() => ({ mockFindRelationship: vi.fn() }));

vi.mock('@balo/db', () => ({
  requestExpertRelationshipsRepository: { findById: mockFindRelationship },
}));

import { resolveMeetingPagePath } from './meeting-page-path.js';

const CONTEXT_ID = '3f2b8c1e-5d4a-4e7b-9c1d-0a6b7c8d9e0f';
const REQUEST_ID = '8a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

describe('resolveMeetingPagePath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('links a case meeting to the case', async () => {
    await expect(
      resolveMeetingPagePath({ contextType: 'case', contextId: CONTEXT_ID }, true)
    ).resolves.toBe(`/cases/${CONTEXT_ID}`);
    expect(mockFindRelationship).not.toHaveBeenCalled();
  });

  it.each(['project_kickoff', 'project_call'] as const)(
    'links a %s meeting to its engagement',
    async (contextType) => {
      await expect(
        resolveMeetingPagePath({ contextType, contextId: CONTEXT_ID }, true)
      ).resolves.toBe(`/engagements/${CONTEXT_ID}`);
    }
  );

  it('links a project_discovery meeting to the request named by its context id', async () => {
    await expect(
      resolveMeetingPagePath({ contextType: 'project_discovery', contextId: REQUEST_ID }, true)
    ).resolves.toBe(`/projects/${REQUEST_ID}`);
    expect(mockFindRelationship).not.toHaveBeenCalled();
  });

  it('resolves a request_interaction meeting through its relationship', async () => {
    mockFindRelationship.mockResolvedValue({ id: CONTEXT_ID, projectRequestId: REQUEST_ID });

    await expect(
      resolveMeetingPagePath({ contextType: 'request_interaction', contextId: CONTEXT_ID }, true)
    ).resolves.toBe(`/projects/${REQUEST_ID}`);
    expect(mockFindRelationship).toHaveBeenCalledWith(CONTEXT_ID);
  });

  it('returns null for a request_interaction whose relationship is gone', async () => {
    mockFindRelationship.mockResolvedValue(undefined);

    await expect(
      resolveMeetingPagePath({ contextType: 'request_interaction', contextId: CONTEXT_ID }, true)
    ).resolves.toBeNull();
  });

  it.each(['package_session', 'retainer_checkin'] as const)(
    'returns null for %s, which has no page',
    async (contextType) => {
      await expect(
        resolveMeetingPagePath({ contextType, contextId: CONTEXT_ID }, true)
      ).resolves.toBeNull();
    }
  );

  it('returns null, and reads nothing, when the owning row was not found', async () => {
    await expect(
      resolveMeetingPagePath({ contextType: 'request_interaction', contextId: CONTEXT_ID }, false)
    ).resolves.toBeNull();
    await expect(
      resolveMeetingPagePath({ contextType: 'case', contextId: CONTEXT_ID }, false)
    ).resolves.toBeNull();
    expect(mockFindRelationship).not.toHaveBeenCalled();
  });
});
