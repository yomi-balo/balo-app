import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSyncWorkHistory, session } = vi.hoisted(() => ({
  mockSyncWorkHistory: vi.fn(),
  session: {
    user: { id: 'user-1', activeMode: 'expert', expertProfileId: 'profile-1' },
  },
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@balo/db', () => ({ expertsRepository: { syncWorkHistory: mockSyncWorkHistory } }));
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
  mockSyncWorkHistory.mockResolvedValue(undefined);
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
    expect(mockSyncWorkHistory).toHaveBeenCalledWith('profile-1', [
      { ...ENTRY, responsibilities: '<p><strong>Led</strong> delivery</p>' },
    ]);
  });

  it('converts an untouched legacy plain-text entry to paragraphs on the way through', async () => {
    await saveWorkHistoryAction({
      entries: [{ ...ENTRY, responsibilities: 'Led delivery\nRan CPQ' }],
    });
    expect(mockSyncWorkHistory).toHaveBeenCalledWith('profile-1', [
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
    expect(mockSyncWorkHistory).not.toHaveBeenCalled();
  });
});
