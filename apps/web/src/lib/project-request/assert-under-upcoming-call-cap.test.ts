import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

const RELATIONSHIP_ID = 'c0000000-0000-4000-8000-000000000002';
const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000003';

const mockListActiveMeetingsForContexts = vi.fn();
vi.mock('@balo/db', () => ({
  meetingsRepository: {
    listActiveMeetingsForContexts: (...args: unknown[]) =>
      mockListActiveMeetingsForContexts(...args),
  },
}));
// The real, pure upcoming rule and merge are under test — never mocked. The cap, the page's
// list and the api gate must count the same calls.

import { assertUnderUpcomingCallCap } from './assert-under-upcoming-call-cap';

const NOW = new Date('2026-08-25T00:00:00.000Z');

function meetingRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    meetingId: id,
    scheduledStart: new Date('2026-08-26T04:00:00.000Z'),
    scheduledEnd: new Date('2026-08-26T04:30:00.000Z'),
    status: 'scheduled',
    ...overrides,
  };
}

function onlyRelationship(rows: unknown[]) {
  mockListActiveMeetingsForContexts.mockImplementation(
    async ({ contextType }: { contextType: string }) =>
      contextType === 'request_interaction' ? new Map([[RELATIONSHIP_ID, rows]]) : new Map()
  );
}

describe('assertUnderUpcomingCallCap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the repository for exactly this relationship on request_interaction, and nothing else without an engagement', async () => {
    onlyRelationship([]);
    await expect(assertUnderUpcomingCallCap(RELATIONSHIP_ID, null)).resolves.toBe(true);
    expect(mockListActiveMeetingsForContexts).toHaveBeenCalledTimes(1);
    expect(mockListActiveMeetingsForContexts).toHaveBeenCalledWith({
      contextType: 'request_interaction',
      contextIds: [RELATIONSHIP_ID],
    });
  });

  it('allows a booking at 2 upcoming calls', async () => {
    onlyRelationship([meetingRow('m-1'), meetingRow('m-2')]);
    await expect(assertUnderUpcomingCallCap(RELATIONSHIP_ID, null)).resolves.toBe(true);
  });

  it('refuses at 3 upcoming calls', async () => {
    onlyRelationship([meetingRow('m-1'), meetingRow('m-2'), meetingRow('m-3')]);
    await expect(assertUnderUpcomingCallCap(RELATIONSHIP_ID, null)).resolves.toBe(false);
  });

  it('does not count ENDED or past-window rows', async () => {
    onlyRelationship([
      meetingRow('m-1'),
      meetingRow('m-2'),
      meetingRow('m-ended', { status: 'ended' }),
      meetingRow('m-past', {
        scheduledStart: new Date('2026-08-24T04:00:00.000Z'),
        scheduledEnd: new Date('2026-08-24T04:30:00.000Z'),
      }),
    ]);
    await expect(assertUnderUpcomingCallCap(RELATIONSHIP_ID, null)).resolves.toBe(true);
  });

  it('counts a call that runs past its scheduled end while it is still live', async () => {
    onlyRelationship([
      meetingRow('m-1'),
      meetingRow('m-2'),
      meetingRow('m-live', {
        status: 'in_progress',
        scheduledStart: new Date('2026-08-24T22:00:00.000Z'),
        scheduledEnd: new Date('2026-08-24T22:30:00.000Z'),
      }),
    ]);
    await expect(assertUnderUpcomingCallCap(RELATIONSHIP_ID, null)).resolves.toBe(false);
  });

  it('counts a meeting present in both contexts once', async () => {
    mockListActiveMeetingsForContexts.mockImplementation(
      async ({ contextType }: { contextType: string }) =>
        contextType === 'request_interaction'
          ? new Map([[RELATIONSHIP_ID, [meetingRow('m-carried'), meetingRow('m-2')]]])
          : new Map([[ENGAGEMENT_ID, [meetingRow('m-carried')]]])
    );
    await expect(assertUnderUpcomingCallCap(RELATIONSHIP_ID, ENGAGEMENT_ID)).resolves.toBe(true);
    expect(mockListActiveMeetingsForContexts).toHaveBeenCalledWith({
      contextType: 'project_call',
      contextIds: [ENGAGEMENT_ID],
    });
  });

  it('sums distinct calls across both contexts', async () => {
    mockListActiveMeetingsForContexts.mockImplementation(
      async ({ contextType }: { contextType: string }) =>
        contextType === 'request_interaction'
          ? new Map([[RELATIONSHIP_ID, [meetingRow('m-1')]]])
          : new Map([[ENGAGEMENT_ID, [meetingRow('m-2'), meetingRow('m-3')]]])
    );
    await expect(assertUnderUpcomingCallCap(RELATIONSHIP_ID, ENGAGEMENT_ID)).resolves.toBe(false);
  });

  it('allows when the repository returns no entry for this id at all', async () => {
    mockListActiveMeetingsForContexts.mockResolvedValue(new Map());
    await expect(assertUnderUpcomingCallCap(RELATIONSHIP_ID, null)).resolves.toBe(true);
  });
});
