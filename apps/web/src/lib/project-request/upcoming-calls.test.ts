import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

const mockListActive = vi.fn();
vi.mock('@balo/db', () => ({
  meetingsRepository: {
    listActiveMeetingsForContexts: (...args: unknown[]) => mockListActive(...args),
  },
}));

import { listUpcomingCallsByThread } from './upcoming-calls';

const REL_A = 'rel-a';
const REL_B = 'rel-b';
const ENGAGEMENT = 'eng-1';
const NOW = new Date('2026-08-25T00:00:00.000Z');

function row(id: string, startIso: string, overrides: Record<string, unknown> = {}) {
  const start = new Date(startIso);
  return {
    meetingId: id,
    scheduledStart: start,
    scheduledEnd: new Date(start.getTime() + 30 * 60_000),
    status: 'scheduled',
    ...overrides,
  };
}

describe('listUpcomingCallsByThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads only request_interaction when there is no project call', async () => {
    mockListActive.mockResolvedValue(new Map([[REL_A, [row('m-1', '2026-08-26T04:00:00.000Z')]]]));
    const result = await listUpcomingCallsByThread({
      relationshipIds: [REL_A, REL_B],
      projectCall: null,
      nowMs: NOW.getTime(),
    });
    expect(mockListActive).toHaveBeenCalledTimes(1);
    expect(mockListActive).toHaveBeenCalledWith({
      contextType: 'request_interaction',
      contextIds: [REL_A, REL_B],
    });
    expect(result.get(REL_A)).toEqual([
      {
        meetingId: 'm-1',
        scheduledStartIso: '2026-08-26T04:00:00.000Z',
        contextType: 'request_interaction',
      },
    ]);
    expect(result.get(REL_B)).toEqual([]);
  });

  it('reads both contexts for the won thread and de-duplicates a carried-over meeting', async () => {
    mockListActive.mockImplementation(async ({ contextType }: { contextType: string }) =>
      contextType === 'request_interaction'
        ? new Map([
            [
              REL_A,
              [
                row('m-carried', '2026-08-26T04:00:00.000Z'),
                row('m-ended', '2026-08-26T05:00:00.000Z', { status: 'ended' }),
              ],
            ],
          ])
        : new Map([
            [
              ENGAGEMENT,
              [
                row('m-carried', '2026-08-26T04:00:00.000Z'),
                row('m-new', '2026-08-27T04:00:00.000Z'),
              ],
            ],
          ])
    );
    const result = await listUpcomingCallsByThread({
      relationshipIds: [REL_A, REL_B],
      projectCall: { relationshipId: REL_A, engagementId: ENGAGEMENT },
      nowMs: NOW.getTime(),
    });
    expect(mockListActive).toHaveBeenCalledTimes(2);
    expect(mockListActive).toHaveBeenCalledWith({
      contextType: 'project_call',
      contextIds: [ENGAGEMENT],
    });
    expect(result.get(REL_A)).toEqual([
      {
        meetingId: 'm-carried',
        scheduledStartIso: '2026-08-26T04:00:00.000Z',
        contextType: 'project_call',
      },
      {
        meetingId: 'm-new',
        scheduledStartIso: '2026-08-27T04:00:00.000Z',
        contextType: 'project_call',
      },
    ]);
    expect(result.get(REL_B)).toEqual([]);
  });

  it('does not attach project calls to a thread other than the won one', async () => {
    mockListActive.mockImplementation(async ({ contextType }: { contextType: string }) =>
      contextType === 'request_interaction'
        ? new Map()
        : new Map([[ENGAGEMENT, [row('m-new', '2026-08-27T04:00:00.000Z')]]])
    );
    const result = await listUpcomingCallsByThread({
      relationshipIds: [REL_A, REL_B],
      projectCall: { relationshipId: REL_A, engagementId: ENGAGEMENT },
      nowMs: NOW.getTime(),
    });
    expect(result.get(REL_B)).toEqual([]);
    expect(result.get(REL_A)).toHaveLength(1);
  });
});
