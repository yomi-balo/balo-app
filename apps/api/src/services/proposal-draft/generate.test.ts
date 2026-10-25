import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DRAFT_DEADLINE_MS } from '@balo/shared/project-requests';
import { NoObjectGeneratedError } from 'ai';

const findGeneration = vi.hoisted(() => vi.fn());
const markSucceeded = vi.hoisted(() => vi.fn());
const findRelationship = vi.hoisted(() => vi.fn());
const findRequest = vi.hoisted(() => vi.fn());
const trackServer = vi.hoisted(() => vi.fn());
const logInfo = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());

vi.mock('@balo/db', () => ({
  proposalDraftGenerationsRepository: {
    findById: (...args: unknown[]) => findGeneration(...args),
    markSucceeded: (...args: unknown[]) => markSucceeded(...args),
  },
  requestExpertRelationshipsRepository: {
    findById: (...args: unknown[]) => findRelationship(...args),
  },
  projectRequestsRepository: {
    findByIdWithRelations: (...args: unknown[]) => findRequest(...args),
  },
}));
vi.mock('@balo/analytics/server', () => ({
  trackServer,
  PROJECT_SERVER_EVENTS: { PROPOSAL_DRAFT_GENERATED: 'project_proposal_draft_generated' },
}));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ warn: logWarn, info: logInfo, error: vi.fn(), debug: vi.fn() }),
}));

import { runProposalDraftGeneration, ProposalDraftGenerationError } from './generate.js';
import { AiModelNotAllowedError, LlmOutputTruncatedError, type AiClient } from '../ai/index.js';
import type { ProposalDraftOutput } from '@balo/shared/project-requests';

const GEN_ID = '11111111-1111-4111-8111-111111111111';
const REL_ID = '22222222-2222-4222-8222-222222222222';
const REQ_ID = '33333333-3333-4333-8333-333333333333';

const pendingRow = {
  id: GEN_ID,
  relationshipId: REL_ID,
  requestedByUserId: 'user-1',
  status: 'pending',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const requestRow = {
  title: 'Fix our CPQ',
  description: '<p>We need <strong>pricing</strong> rules.</p>',
  company: { id: 'c1', name: 'Northwind' },
  tags: [{ projectTag: { id: 't1', name: 'Integration' } }],
  products: [{ product: { id: 'p1', name: 'Sales Cloud' } }],
};

const goodOutput: ProposalDraftOutput = {
  overviewHtml: '<p>Hi Northwind.</p>',
  milestones: [
    {
      title: 'Discovery',
      descriptionHtml: '<p>Learn.</p>',
      acceptanceCriteria: 'Done when agreed.',
    },
    { title: 'Build', descriptionHtml: '<p>Do.</p>', acceptanceCriteria: 'Done when live.' },
  ],
};

function aiReturning(value: ProposalDraftOutput): {
  ai: AiClient;
  generateObject: ReturnType<typeof vi.fn>;
} {
  const generateObject = vi.fn().mockResolvedValue({
    value,
    audit: {
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      modelVersion: null,
      promptId: 'proposal-draft.generate',
      promptVersion: 'v1',
      prompt: 'p',
    },
    usage: { inputTokens: 900, outputTokens: 400 },
  });
  return { ai: { generateText: vi.fn(), generateObject } as unknown as AiClient, generateObject };
}

function aiRejecting(error: unknown): AiClient {
  return {
    generateText: vi.fn(),
    generateObject: vi.fn().mockRejectedValue(error),
  } as unknown as AiClient;
}

describe('runProposalDraftGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:10.000Z'));
    findGeneration.mockResolvedValue(pendingRow);
    findRelationship.mockResolvedValue({ id: REL_ID, projectRequestId: REQ_ID });
    findRequest.mockResolvedValue(requestRow);
    markSucceeded.mockResolvedValue({
      ...pendingRow,
      status: 'succeeded',
      completedAt: new Date('2026-01-01T00:00:12.500Z'),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('throws an unknown error when the row is missing', async () => {
    findGeneration.mockResolvedValue(undefined);
    const { ai, generateObject } = aiReturning(goodOutput);
    await expect(runProposalDraftGeneration(GEN_ID, { ai })).rejects.toMatchObject({
      name: 'ProposalDraftGenerationError',
      reason: 'unknown',
    });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('returns without a model call when the row is already settled', async () => {
    findGeneration.mockResolvedValue({ ...pendingRow, status: 'succeeded' });
    const { ai, generateObject } = aiReturning(goodOutput);
    await runProposalDraftGeneration(GEN_ID, { ai });
    expect(generateObject).not.toHaveBeenCalled();
    expect(findRelationship).not.toHaveBeenCalled();
    expect(markSucceeded).not.toHaveBeenCalled();
  });

  it('fails source_unavailable when the relationship is gone', async () => {
    findRelationship.mockResolvedValue(undefined);
    const { ai } = aiReturning(goodOutput);
    await expect(runProposalDraftGeneration(GEN_ID, { ai })).rejects.toMatchObject({
      reason: 'source_unavailable',
    });
  });

  it('fails source_unavailable when the request is gone', async () => {
    findRequest.mockResolvedValue(undefined);
    const { ai } = aiReturning(goodOutput);
    await expect(runProposalDraftGeneration(GEN_ID, { ai })).rejects.toMatchObject({
      reason: 'source_unavailable',
    });
  });

  it('abandons without a model call when the row settled while the inputs loaded', async () => {
    findGeneration
      .mockResolvedValueOnce(pendingRow)
      .mockResolvedValueOnce({ ...pendingRow, status: 'failed' });
    const { ai, generateObject } = aiReturning(goodOutput);
    await runProposalDraftGeneration(GEN_ID, { ai });
    expect(generateObject).not.toHaveBeenCalled();
    expect(markSucceeded).not.toHaveBeenCalled();
    expect(logInfo).toHaveBeenCalledWith(
      { generationId: GEN_ID },
      'Proposal draft abandoned before the model call — row is settled'
    );
  });

  it('abandons when the row vanished before the model call', async () => {
    findGeneration.mockResolvedValueOnce(pendingRow).mockResolvedValueOnce(undefined);
    const { ai, generateObject } = aiReturning(goodOutput);
    await runProposalDraftGeneration(GEN_ID, { ai });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('builds the prompt from the request: plain-text description, tags, products, company', async () => {
    const { ai, generateObject } = aiReturning(goodOutput);
    await runProposalDraftGeneration(GEN_ID, { ai });
    const request = generateObject.mock.calls[0]?.[0] as { prompt: string; promptId: string };
    expect(request.promptId).toBe('proposal-draft.generate');
    expect(request.prompt).toContain('Northwind');
    expect(request.prompt).toContain('Fix our CPQ');
    expect(request.prompt).toContain('We need pricing rules.');
    expect(request.prompt).not.toContain('<strong>');
    expect(request.prompt).toContain('- Integration');
    expect(request.prompt).toContain('- Sales Cloud');
  });

  it('addresses no company when the request has none', async () => {
    findRequest.mockResolvedValue({ ...requestRow, company: null });
    const { ai, generateObject } = aiReturning(goodOutput);
    await runProposalDraftGeneration(GEN_ID, { ai });
    const request = generateObject.mock.calls[0]?.[0] as { prompt: string };
    expect(request.prompt).toContain('<company-name>\n(not given)\n</company-name>');
  });

  it('calls the model with the default model and the output ceiling', async () => {
    vi.stubEnv('PROPOSAL_DRAFT_MODEL', '');
    const { ai, generateObject } = aiReturning(goodOutput);
    await runProposalDraftGeneration(GEN_ID, { ai });
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'claude-sonnet-5', maxOutputTokens: 4096 })
    );
  });

  it('persists the output with the audit and usage, then fires GENERATED succeeded', async () => {
    const { ai } = aiReturning(goodOutput);
    await runProposalDraftGeneration(GEN_ID, { ai });

    expect(markSucceeded).toHaveBeenCalledWith({
      generationId: GEN_ID,
      output: goodOutput,
      modelId: 'claude-sonnet-5',
      promptVersion: 'v1',
      inputTokens: 900,
      outputTokens: 400,
    });
    expect(trackServer).toHaveBeenCalledTimes(1);
    expect(trackServer).toHaveBeenCalledWith('project_proposal_draft_generated', {
      relationship_id: REL_ID,
      status: 'succeeded',
      latency_ms: 12_500,
      milestone_count: 2,
      distinct_id: 'user-1',
    });
    expect(logInfo).toHaveBeenCalledWith(
      {
        generationId: GEN_ID,
        modelId: 'claude-sonnet-5',
        inputTokens: 900,
        outputTokens: 400,
        milestoneCount: 2,
        promptVersion: 'v1',
      },
      'Proposal draft generated'
    );
  });

  it('fires no analytics and no success log when the compare-and-set lost', async () => {
    markSucceeded.mockResolvedValue(undefined);
    const { ai } = aiReturning(goodOutput);
    await runProposalDraftGeneration(GEN_ID, { ai });
    expect(trackServer).not.toHaveBeenCalled();
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('fails empty_output when the overview has no visible text', async () => {
    const { ai } = aiReturning({ ...goodOutput, overviewHtml: '<p>  </p>' });
    await expect(runProposalDraftGeneration(GEN_ID, { ai })).rejects.toMatchObject({
      reason: 'empty_output',
    });
    expect(markSucceeded).not.toHaveBeenCalled();
    expect(trackServer).not.toHaveBeenCalled();
  });

  it('fails empty_output when a milestone title is under 3 characters', async () => {
    const { ai } = aiReturning({
      ...goodOutput,
      milestones: goodOutput.milestones.map((m, i) => (i === 0 ? { ...m, title: ' A ' } : m)),
    });
    await expect(runProposalDraftGeneration(GEN_ID, { ai })).rejects.toMatchObject({
      reason: 'empty_output',
    });
    expect(markSucceeded).not.toHaveBeenCalled();
  });

  it('fails model_unavailable, without a model call, for an override outside the allow-list', async () => {
    vi.stubEnv('PROPOSAL_DRAFT_MODEL', 'gpt-4');
    const { ai, generateObject } = aiReturning(goodOutput);
    const error = await runProposalDraftGeneration(GEN_ID, { ai }).catch(
      (error_: unknown) => error_
    );
    expect(error).toBeInstanceOf(ProposalDraftGenerationError);
    expect((error as ProposalDraftGenerationError).reason).toBe('model_unavailable');
    expect((error as ProposalDraftGenerationError).cause).toBeInstanceOf(AiModelNotAllowedError);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('fails truncated when the model hits its output ceiling', async () => {
    const ai = aiRejecting(new LlmOutputTruncatedError('cut off'));
    await expect(runProposalDraftGeneration(GEN_ID, { ai })).rejects.toMatchObject({
      reason: 'truncated',
    });
  });

  it('leaves an invalid structured output as the raw SDK error (retryable) and logs only its name', async () => {
    const sdkError = new NoObjectGeneratedError({
      message: 'raw model output: SECRET',
      response: {} as never,
      usage: {} as never,
      finishReason: 'stop',
    });
    const ai = aiRejecting(sdkError);
    await expect(runProposalDraftGeneration(GEN_ID, { ai })).rejects.toBe(sdkError);
    expect(logWarn).toHaveBeenCalledWith(
      { generationId: GEN_ID, errorName: sdkError.name },
      'Proposal draft — model returned an invalid structured output'
    );
    expect(JSON.stringify(logWarn.mock.calls)).not.toContain('SECRET');
  });

  it('rethrows an unclassified provider error untouched', async () => {
    const boom = new Error('network');
    const ai = aiRejecting(boom);
    await expect(runProposalDraftGeneration(GEN_ID, { ai })).rejects.toBe(boom);
  });

  describe('deadline', () => {
    const createdAtMs = pendingRow.createdAt.getTime();

    it('abandons as deadline_exceeded, with no model call, when the row is past the deadline', async () => {
      vi.setSystemTime(createdAtMs + DRAFT_DEADLINE_MS + 1);
      const { ai, generateObject } = aiReturning(goodOutput);
      await expect(runProposalDraftGeneration(GEN_ID, { ai })).rejects.toMatchObject({
        name: 'ProposalDraftGenerationError',
        reason: 'deadline_exceeded',
      });
      expect(generateObject).not.toHaveBeenCalled();
      expect(markSucceeded).not.toHaveBeenCalled();
      expect(trackServer).not.toHaveBeenCalled();
    });

    it('still calls the model when the row is exactly at the deadline', async () => {
      vi.setSystemTime(createdAtMs + DRAFT_DEADLINE_MS);
      const { ai, generateObject } = aiReturning(goodOutput);
      await runProposalDraftGeneration(GEN_ID, { ai });
      expect(generateObject).toHaveBeenCalledTimes(1);
      expect(markSucceeded).toHaveBeenCalledTimes(1);
    });

    it('does not save a result the model returned after the deadline', async () => {
      vi.setSystemTime(createdAtMs + 5_000);
      const generateObject = vi.fn().mockImplementation(() => {
        vi.setSystemTime(createdAtMs + DRAFT_DEADLINE_MS + 1);
        return Promise.resolve({
          value: goodOutput,
          audit: { modelId: 'claude-sonnet-5', promptVersion: 'v1' },
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      });
      const ai = { generateText: vi.fn(), generateObject } as unknown as AiClient;
      await expect(runProposalDraftGeneration(GEN_ID, { ai })).rejects.toMatchObject({
        reason: 'deadline_exceeded',
      });
      expect(generateObject).toHaveBeenCalledTimes(1);
      expect(markSucceeded).not.toHaveBeenCalled();
      expect(trackServer).not.toHaveBeenCalled();
    });
  });
});
