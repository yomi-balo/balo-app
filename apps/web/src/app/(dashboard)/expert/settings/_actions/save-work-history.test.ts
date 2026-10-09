import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSaveSettingsWorkHistory, session } = vi.hoisted(() => ({
  mockSaveSettingsWorkHistory: vi.fn(),
  session: {
    user: { id: 'user-1', activeMode: 'expert', expertProfileId: 'profile-1' },
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@balo/db', () => ({
  expertsRepository: { saveSettingsWorkHistory: mockSaveSettingsWorkHistory },
}));
vi.mock('@/lib/auth/with-auth', () => ({
  withAuth:
    <TInput, TResult>(handler: (s: typeof session, input: TInput) => Promise<TResult>) =>
    (input: TInput) =>
      handler(session, input),
}));

import { saveWorkHistoryAction } from './save-work-history';

const ENTRY = {
  role: 'Senior Consultant',
  company: 'Acme Corp',
  startedAt: '2020-01-01',
  endedAt: '2023-06-01',
  isCurrent: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveSettingsWorkHistory.mockResolvedValue({ outcome: 'saved' });
});

describe('saveWorkHistoryAction — responsibilities', () => {
  it('sanitises rich text before it is stored', async () => {
    const result = await saveWorkHistoryAction({
      entries: [
        {
          ...ENTRY,
          responsibilities: '<p><strong>Led</strong> delivery</p><script>alert(1)</script>',
        },
      ],
    });
    expect(result).toEqual({ success: true });
    expect(mockSaveSettingsWorkHistory).toHaveBeenCalledWith('profile-1', [
      { ...ENTRY, responsibilities: '<p><strong>Led</strong> delivery</p>' },
    ]);
  });

  it('converts an untouched legacy plain-text entry to paragraphs on the way through', async () => {
    await saveWorkHistoryAction({
      entries: [{ ...ENTRY, responsibilities: 'Led delivery\nRan CPQ' }],
    });
    expect(mockSaveSettingsWorkHistory).toHaveBeenCalledWith('profile-1', [
      { ...ENTRY, responsibilities: '<p>Led delivery</p><p>Ran CPQ</p>' },
    ]);
  });

  it('refuses more than 1,000 visible characters and writes nothing', async () => {
    const result = await saveWorkHistoryAction({
      entries: [{ ...ENTRY, responsibilities: `<p>${'a'.repeat(1001)}</p>` }],
    });
    expect(result).toEqual({
      success: false,
      error: 'Keep responsibilities under 1000 characters.',
    });
    expect(mockSaveSettingsWorkHistory).not.toHaveBeenCalled();
  });
});

describe('saveWorkHistoryAction — not_found outcome (BAL-557)', () => {
  // MUTATION-PROOF: change the `not_found` branch to fall through to `{ success: true }` and
  // this goes red — proves the action actually reads the repository's outcome.
  it('maps saveSettingsWorkHistory not_found to the expert-profile-required error', async () => {
    mockSaveSettingsWorkHistory.mockResolvedValue({ outcome: 'not_found' });
    const result = await saveWorkHistoryAction({ entries: [ENTRY] });
    expect(result).toEqual({ success: false, error: 'Expert profile required' });
  });
});
