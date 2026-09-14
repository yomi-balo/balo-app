import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { generateText, generateObject } from 'ai';
import { createAiClient, LlmOutputTruncatedError } from './client.js';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('ai', () => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn(() => (modelId: string) => ({ modelId })),
}));

const testSchema = z.object({ title: z.string() });

const baseTextRequest = {
  modelId: 'claude-sonnet-5',
  system: 'system',
  prompt: 'prompt',
  maxOutputTokens: 100,
  promptId: 'test.prompt',
  promptVersion: 'v1',
};

describe('createAiClient', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('warns once across the process when the key is absent (Noop path, no network)', async () => {
    createAiClient({ productionRequirementLabel: 'test' });
    createAiClient({ productionRequirementLabel: 'test' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
  });

  it('Noop generateText returns the caller-supplied fallback, modelId "noop", populated audit.prompt', async () => {
    const client = createAiClient({ productionRequirementLabel: 'test' });
    const result = await client.generateText({
      ...baseTextRequest,
      noopFallback: () => 'FALLBACK_TEXT',
    });
    expect(result.value).toBe('FALLBACK_TEXT');
    expect(result.audit.modelId).toBe('noop');
    expect(result.audit.prompt.length).toBeGreaterThan(0);
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it('Noop generateObject returns the caller-supplied fallback object', async () => {
    const client = createAiClient({ productionRequirementLabel: 'test' });
    const result = await client.generateObject({
      ...baseTextRequest,
      schema: testSchema,
      noopFallback: () => ({ title: 'stub' }),
    });
    expect(result.value).toEqual({ title: 'stub' });
    expect(result.audit.modelId).toBe('noop');
  });

  it('throws (not Noop) when the key is absent in production, naming the caller label', () => {
    process.env.NODE_ENV = 'production';
    expect(() => createAiClient({ productionRequirementLabel: 'the widget service' })).toThrow(
      /ANTHROPIC_API_KEY is required in production \(the widget service\)/
    );
  });

  it('present key → generateText assembles the audit + maps usage, no truncation', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(generateText).mockResolvedValue({
      text: 'MODEL_OUTPUT',
      finishReason: 'stop',
      response: { modelId: 'claude-sonnet-5' },
      usage: { inputTokens: 42, outputTokens: 7 },
    } as never);

    const client = createAiClient({ productionRequirementLabel: 'test' });
    const result = await client.generateText({ ...baseTextRequest, noopFallback: () => '' });

    expect(result.value).toBe('MODEL_OUTPUT');
    expect(result.audit).toMatchObject({
      provider: 'anthropic',
      modelId: 'claude-sonnet-5',
      promptId: 'test.prompt',
      promptVersion: 'v1',
    });
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
  });

  it('present key → generateText throws LlmOutputTruncatedError on finishReason=length', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(generateText).mockResolvedValue({
      text: 'PARTIAL',
      finishReason: 'length',
      response: { modelId: 'claude-sonnet-5' },
    } as never);

    const client = createAiClient({ productionRequirementLabel: 'test' });
    await expect(
      client.generateText({ ...baseTextRequest, noopFallback: () => '' })
    ).rejects.toThrow(LlmOutputTruncatedError);
  });

  it('present key → generateObject (text-only path) passes `prompt` and NO `messages`', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: 'from model' },
      finishReason: 'stop',
      response: { modelId: 'claude-sonnet-5' },
      usage: { inputTokens: 10, outputTokens: 5 },
    } as never);

    const client = createAiClient({ productionRequirementLabel: 'test' });
    const result = await client.generateObject({
      ...baseTextRequest,
      schema: testSchema,
      noopFallback: () => ({ title: '' }),
    });

    expect(result.value).toEqual({ title: 'from model' });
    expect(vi.mocked(generateObject)).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'prompt' })
    );
    const call = vi.mocked(generateObject).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('messages');
  });

  it('present key → generateObject (multimodal path) passes `messages` with the file part shape, no `prompt`', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: 'from model' },
      finishReason: 'stop',
      response: { modelId: 'claude-sonnet-5' },
      usage: { inputTokens: 10, outputTokens: 5 },
    } as never);

    const client = createAiClient({ productionRequirementLabel: 'test' });
    await client.generateObject({
      ...baseTextRequest,
      schema: testSchema,
      noopFallback: () => ({ title: '' }),
      files: [{ data: new Uint8Array([1, 2, 3]), mediaType: 'application/pdf', filename: 'a.pdf' }],
    });

    const call = vi.mocked(generateObject).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('prompt');
    expect(call.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'prompt' },
          {
            type: 'file',
            data: new Uint8Array([1, 2, 3]),
            mediaType: 'application/pdf',
            filename: 'a.pdf',
          },
        ],
      },
    ]);
  });

  it('a file part with no filename omits the key entirely (never sets it to undefined)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: 'x' },
      finishReason: 'stop',
      response: { modelId: 'claude-sonnet-5' },
    } as never);

    const client = createAiClient({ productionRequirementLabel: 'test' });
    await client.generateObject({
      ...baseTextRequest,
      schema: testSchema,
      noopFallback: () => ({ title: '' }),
      files: [{ data: new Uint8Array([9]), mediaType: 'image/png' }],
    });

    const call = vi.mocked(generateObject).mock.calls[0]?.[0] as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const filePart = call.messages[0]?.content[1];
    expect(filePart).toBeDefined();
    expect(filePart && 'filename' in filePart).toBe(false);
  });

  it('present key → generateObject throws LlmOutputTruncatedError on finishReason=length', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(generateObject).mockResolvedValue({
      object: { title: 'partial' },
      finishReason: 'length',
      response: { modelId: 'claude-sonnet-5' },
    } as never);

    const client = createAiClient({ productionRequirementLabel: 'test' });
    await expect(
      client.generateObject({
        ...baseTextRequest,
        schema: testSchema,
        noopFallback: () => ({ title: '' }),
      })
    ).rejects.toThrow(LlmOutputTruncatedError);
  });

  it('usage.inputTokens/outputTokens undefined from the provider maps to null', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    vi.mocked(generateText).mockResolvedValue({
      text: 'X',
      finishReason: 'stop',
      response: { modelId: 'claude-sonnet-5' },
      usage: {},
    } as never);

    const client = createAiClient({ productionRequirementLabel: 'test' });
    const result = await client.generateText({ ...baseTextRequest, noopFallback: () => '' });
    expect(result.usage).toEqual({ inputTokens: null, outputTokens: null });
  });
});
