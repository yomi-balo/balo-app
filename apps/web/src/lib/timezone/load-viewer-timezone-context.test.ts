import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFindTimezoneContext, mockWarn } = vi.hoisted(() => ({
  mockFindTimezoneContext: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, cache: <T>(fn: T): T => fn };
});
vi.mock('@balo/db', () => ({
  usersRepository: { findTimezoneContext: mockFindTimezoneContext },
}));
vi.mock('@/lib/logging', () => ({
  log: { warn: mockWarn },
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));

import { loadViewerTimezoneContext } from './load-viewer-timezone-context';

const USER = { id: 'user-1', expertProfileId: 'ep-1' };

const RULES = [
  { dayOfWeek: 1, startTime: '09:00:00', endTime: '17:00:00' },
  { dayOfWeek: 2, startTime: '09:00:00', endTime: '17:00:00' },
];

function expertContext(
  overrides: Partial<{
    approved: boolean;
    availableForWork: boolean;
    rules: typeof RULES;
  }> = {}
): unknown {
  return {
    savedTimezone: 'Australia/Sydney',
    expert: {
      expertProfileId: 'ep-1',
      timezone: 'Australia/Sydney',
      approved: true,
      availableForWork: true,
      rules: RULES,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadViewerTimezoneContext', () => {
  it('scopes the read to the session user and expert profile', async () => {
    mockFindTimezoneContext.mockResolvedValue(expertContext());
    await loadViewerTimezoneContext(USER);
    expect(mockFindTimezoneContext).toHaveBeenCalledWith('user-1', 'ep-1');
  });

  it('prompts an approved, unpaused expert with hours, carrying the common range', async () => {
    mockFindTimezoneContext.mockResolvedValue(expertContext());
    expect(await loadViewerTimezoneContext(USER)).toEqual({
      savedTimezone: 'Australia/Sydney',
      mismatchPrompt: {
        expertProfileId: 'ep-1',
        scheduleTimezone: 'Australia/Sydney',
        commonRange: { startTime: '09:00', endTime: '17:00' },
      },
    });
  });

  it('keeps the saved zone but never prompts an impersonated session', async () => {
    mockFindTimezoneContext.mockResolvedValue(expertContext());
    expect(await loadViewerTimezoneContext({ ...USER, isImpersonating: true })).toEqual({
      savedTimezone: 'Australia/Sydney',
      mismatchPrompt: null,
    });
  });

  it('does not prompt a paused expert', async () => {
    mockFindTimezoneContext.mockResolvedValue(expertContext({ availableForWork: false }));
    const result = await loadViewerTimezoneContext(USER);
    expect(result.mismatchPrompt).toBeNull();
    expect(result.savedTimezone).toBe('Australia/Sydney');
  });

  it('does not prompt an expert with no weekly hours', async () => {
    mockFindTimezoneContext.mockResolvedValue(expertContext({ rules: [] }));
    expect((await loadViewerTimezoneContext(USER)).mismatchPrompt).toBeNull();
  });

  it('does not prompt an unapproved expert', async () => {
    mockFindTimezoneContext.mockResolvedValue(expertContext({ approved: false, rules: [] }));
    expect((await loadViewerTimezoneContext(USER)).mismatchPrompt).toBeNull();
  });

  it('returns only the saved zone for a user with no expert profile', async () => {
    mockFindTimezoneContext.mockResolvedValue({ savedTimezone: 'Europe/London', expert: null });
    expect(await loadViewerTimezoneContext({ id: 'user-2', expertProfileId: undefined })).toEqual({
      savedTimezone: 'Europe/London',
      mismatchPrompt: null,
    });
  });

  it('returns nulls when the user row is missing', async () => {
    mockFindTimezoneContext.mockResolvedValue(null);
    expect(await loadViewerTimezoneContext(USER)).toEqual({
      savedTimezone: null,
      mismatchPrompt: null,
    });
  });

  it('logs a warning and returns nulls when the read throws', async () => {
    mockFindTimezoneContext.mockRejectedValue(new Error('db down'));
    expect(await loadViewerTimezoneContext(USER)).toEqual({
      savedTimezone: null,
      mismatchPrompt: null,
    });
    expect(mockWarn).toHaveBeenCalledWith('Failed to load viewer timezone context', {
      userId: 'user-1',
      error: 'db down',
    });
  });

  it('never reads the active view', () => {
    const source = readFileSync(join(__dirname, 'load-viewer-timezone-context.ts'), 'utf8');
    expect(source).not.toContain('activeMode');
  });
});
