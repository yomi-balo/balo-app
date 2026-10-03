import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProjectBriefParse } from '@balo/db';
import { loadCaseSource } from './case-source.js';
import { ProjectBriefParseError } from './parse.js';

const findByEngagementId = vi.fn();
const findUserIdsByProfileIds = vi.fn();
const findByContext = vi.fn();
const listMessages = vi.fn();
const listMeetingsForContext = vi.fn();
const findByMeetingIds = vi.fn();

vi.mock('@balo/db', () => ({
  caseEngagementsRepository: {
    findByEngagementId: (...args: unknown[]) => findByEngagementId(...args),
  },
  expertsRepository: {
    findUserIdsByProfileIds: (...args: unknown[]) => findUserIdsByProfileIds(...args),
  },
  conversationsRepository: {
    findByContext: (...args: unknown[]) => findByContext(...args),
    listMessages: (...args: unknown[]) => listMessages(...args),
  },
  meetingContextsRepository: {
    listMeetingsForContext: (...args: unknown[]) => listMeetingsForContext(...args),
  },
  transcriptsRepository: {
    findByMeetingIds: (...args: unknown[]) => findByMeetingIds(...args),
    findById: vi.fn(),
  },
  transcriptArtifactsRepository: {
    findByTranscriptAndKind: vi.fn(),
  },
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const OWNER_COMPANY = '11111111-1111-1111-1111-111111111111';
const PARSE_ID = '22222222-2222-2222-2222-222222222222';
const CASE_ID = '33333333-3333-3333-3333-333333333333';
const EXPERT_PROFILE_ID = '44444444-4444-4444-4444-444444444444';

function parseRow(overrides: Partial<ProjectBriefParse> = {}): ProjectBriefParse {
  return {
    id: PARSE_ID,
    companyId: OWNER_COMPANY,
    requestedByUserId: 'requester-1',
    sourceDocuments: [],
    sourceEngagementId: CASE_ID,
    result: null,
    failureReason: null,
    completedAt: null,
    modelId: null,
    modelVersion: null,
    promptId: null,
    promptVersion: null,
    inputTokens: null,
    outputTokens: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listMeetingsForContext.mockResolvedValue([]);
});

describe('loadCaseSource', () => {
  it('a wrong-company case fails the gate with `case_unavailable`', async () => {
    findByEngagementId.mockResolvedValue({
      companyId: 'a-different-company',
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'Some case',
    });

    await expect(loadCaseSource(parseRow(), PARSE_ID)).rejects.toMatchObject({
      reason: 'case_unavailable',
    });
    expect(findByContext).not.toHaveBeenCalled();
    expect(listMessages).not.toHaveBeenCalled();
    expect(listMeetingsForContext).not.toHaveBeenCalled();
    expect(findByMeetingIds).not.toHaveBeenCalled();
  });

  it('an undefined case fails the gate with `case_unavailable`', async () => {
    findByEngagementId.mockResolvedValue(undefined);

    await expect(loadCaseSource(parseRow(), PARSE_ID)).rejects.toBeInstanceOf(
      ProjectBriefParseError
    );
  });

  it('a row with no case source throws `case_unavailable` rather than reading anything', async () => {
    await expect(
      loadCaseSource(parseRow({ sourceEngagementId: null }), PARSE_ID)
    ).rejects.toMatchObject({ reason: 'case_unavailable' });
    expect(findByEngagementId).not.toHaveBeenCalled();
  });

  it('a case with no messages and no transcripts fails with `no_case_history`', async () => {
    findByEngagementId.mockResolvedValue({
      companyId: OWNER_COMPANY,
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'Some case',
    });
    findUserIdsByProfileIds.mockResolvedValue([]);
    findByContext.mockResolvedValue(undefined);

    await expect(loadCaseSource(parseRow(), PARSE_ID)).rejects.toMatchObject({
      reason: 'no_case_history',
    });
  });

  it('a live case with history returns the case title and rendered history', async () => {
    findByEngagementId.mockResolvedValue({
      companyId: OWNER_COMPANY,
      expertProfileId: EXPERT_PROFILE_ID,
      title: 'Sandbox refresh keeps failing',
    });
    findUserIdsByProfileIds.mockResolvedValue(['expert-user-1']);
    findByContext.mockResolvedValue({ id: 'conv-1' });
    listMessages.mockResolvedValue([
      {
        senderUserId: 'client-user-1',
        body: 'The sandbox refresh keeps failing.',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const result = await loadCaseSource(parseRow(), PARSE_ID);

    expect(result.caseTitle).toBe('Sandbox refresh keeps failing');
    expect(result.historyText).toContain('The sandbox refresh keeps failing.');
    expect(result.messageCount).toBe(1);
    expect(result.transcriptCount).toBe(0);
    expect(result.truncated).toBe(false);
  });
});
