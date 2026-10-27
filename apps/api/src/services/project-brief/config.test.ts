import { describe, it, expect, afterEach, vi } from 'vitest';
import { AiModelNotAllowedError } from '../ai/index.js';
import {
  DEFAULT_PROJECT_BRIEF_MODEL,
  PROJECT_BRIEF_MODEL_ALLOW_LIST,
  resolveProjectBriefModel,
} from './config.js';

describe('resolveProjectBriefModel', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to claude-opus-5', () => {
    vi.stubEnv('PROJECT_BRIEF_MODEL', '');
    expect(DEFAULT_PROJECT_BRIEF_MODEL).toBe('claude-opus-5');
    expect(resolveProjectBriefModel()).toBe('claude-opus-5');
  });

  it('lists exactly the approved vision-capable models', () => {
    expect(PROJECT_BRIEF_MODEL_ALLOW_LIST).toEqual([
      'claude-sonnet-5-5',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-opus-4-8',
    ]);
  });

  it('accepts claude-sonnet-5-5 as an override', () => {
    vi.stubEnv('PROJECT_BRIEF_MODEL', 'claude-sonnet-5-5');
    expect(resolveProjectBriefModel()).toBe('claude-sonnet-5-5');
  });

  it('rejects an override outside the allow-list', () => {
    vi.stubEnv('PROJECT_BRIEF_MODEL', 'gpt-4');
    expect(() => resolveProjectBriefModel()).toThrow(AiModelNotAllowedError);
  });
});
