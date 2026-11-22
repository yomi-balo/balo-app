import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockSchedule, mockDecided, mockFind, mockResolve, mockTimezone, mockLogger } = vi.hoisted(
  () => ({
    mockSchedule: vi.fn(),
    mockDecided: vi.fn(),
    mockFind: vi.fn(),
    mockResolve: vi.fn(),
    mockTimezone: vi.fn(),
    mockLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  })
);

vi.mock('@balo/db', () => ({
  usersRepository: { findTimezoneContext: mockTimezone },
}));
vi.mock('@balo/shared/logging', () => ({ createLogger: () => mockLogger }));
vi.mock('../notifications/scheduling/schedule.js', () => ({ scheduleNotification: mockSchedule }));
vi.mock('../notifications/scheduling/scheduled-key-decided.js', () => ({
  isScheduledKeyDecided: mockDecided,
}));
vi.mock('../notifications/sequences/registry.js', () => ({
  allReminderSequences: () => [
    {
      id: 'proposal_review',
      event: 'project.proposal_review_reminder',
      cadence: 'hourly',
      find: (...args: unknown[]) => mockFind(...args),
      resolveRecipients: (...args: unknown[]) => mockResolve(...args),
      buildPayload: (
        entity: { entityId: string },
        step: string,
        userId: string,
        correlationId: string
      ) => ({
        correlationId,
        step,
        recipientUserId: userId,
        entityId: entity.entityId,
        awaitingCount: 3,
      }),
    },
  ],
}));
vi.mock('../lib/redis.js', () => ({ createRedisConnection: () => ({}) }));
const mockQueueAdd = vi.fn();
vi.mock('../lib/queue.js', () => ({ getQueue: vi.fn(() => ({ add: mockQueueAdd })) }));
vi.mock('bullmq', () => ({ Worker: class MockWorker {} }));

import {
  REMINDER_SEQUENCE_SWEEP_CRONS,
  REMINDER_SEQUENCE_SWEEP_QUEUE,
  registerReminderSequenceSweepCron,
  runReminderSequenceSweep,
} from './reminder-sequence-sweep.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The anchor is Monday 2026-11-02 00:00 UTC; day_2 sends Thu 2026-11-05 09:00 Melbourne.
const ANCHOR = new Date('2026-11-02T00:00:00.000Z');
// 09:00 Melbourne on 2026-11-05 is 22:00 UTC on 11-04.
const NOW = new Date('2026-11-04T21:30:00.000Z');
const entity = { entityId: 'req-1', anchor: ANCHOR, companyId: 'co-1' };

beforeEach(() => {
  vi.clearAllMocks();
  mockFind.mockResolvedValue([entity]);
  mockResolve.mockResolvedValue(['user-1']);
  mockTimezone.mockResolvedValue({ savedTimezone: null, expert: null });
  mockDecided.mockResolvedValue(false);
  mockSchedule.mockResolvedValue({ outcome: 'scheduled' });
});

describe('runReminderSequenceSweep', () => {
  it('arms the due step once per entity and recipient with a fresh uuid, recheck and first_wins', async () => {
    const result = await runReminderSequenceSweep(NOW, 'hourly');

    expect(result).toEqual({ armed: 1, entities: 1 });
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const [event, payload, options] = mockSchedule.mock.calls[0] ?? [];
    expect(event).toBe('project.proposal_review_reminder');
    expect(payload).toMatchObject({ step: 'day_2', awaitingCount: 3, recipientUserId: 'user-1' });
    expect(payload.correlationId).toMatch(UUID);
    expect(options).toEqual({
      key: 'seq:proposal_review:req-1:day_2:user-1:2026-11-02T00:00:00.000Z',
      at: new Date('2026-11-04T22:00:00.000Z'),
      mode: 'first_wins',
      recheck: 'reminder_sequence',
    });
  });

  it('gives each armed promise its own correlation id', async () => {
    mockFind.mockResolvedValue([entity, { ...entity, entityId: 'req-2' }]);
    await runReminderSequenceSweep(NOW, 'hourly');
    const ids = mockSchedule.mock.calls.map(([, payload]) => payload.correlationId);
    expect(new Set(ids).size).toBe(2);
  });

  it('arms nothing when the step is not yet within the lead', async () => {
    const result = await runReminderSequenceSweep(new Date('2026-11-04T10:00:00.000Z'), 'hourly');
    expect(result).toEqual({ armed: 0, entities: 1 });
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('does not arm a key that has already been decided', async () => {
    mockDecided.mockResolvedValue(true);
    expect(await runReminderSequenceSweep(NOW, 'hourly')).toEqual({ armed: 0, entities: 1 });
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('does not count a step that folded into a pending promise', async () => {
    mockSchedule.mockResolvedValue({ outcome: 'already_pending' });
    expect(await runReminderSequenceSweep(NOW, 'hourly')).toEqual({ armed: 0, entities: 1 });
  });

  it('arms the same step under a new key when the anchor moved', async () => {
    const moved = { ...entity, anchor: new Date('2026-11-02T06:00:00.000Z') };
    mockFind.mockResolvedValue([moved]);
    await runReminderSequenceSweep(NOW, 'hourly');
    expect(mockSchedule.mock.calls[0]?.[2].key).toBe(
      'seq:proposal_review:req-1:day_2:user-1:2026-11-02T06:00:00.000Z'
    );
  });

  it('arms nothing for a request with no recipient', async () => {
    mockResolve.mockResolvedValue([]);
    expect(await runReminderSequenceSweep(NOW, 'hourly')).toEqual({ armed: 0, entities: 1 });
  });

  it('reads the zone from the recipient, defaulting to Melbourne when unset', async () => {
    mockTimezone.mockResolvedValue({ savedTimezone: 'UTC', expert: null });
    await runReminderSequenceSweep(NOW, 'hourly');
    expect(mockSchedule.mock.calls[0]?.[2].at).toEqual(new Date('2026-11-04T22:00:00.000Z'));
    expect(mockTimezone).toHaveBeenCalledWith('user-1', undefined);
  });

  it('isolates a failing entity and logs it, then continues', async () => {
    mockFind.mockResolvedValue([{ ...entity, entityId: 'bad' }, entity]);
    mockResolve.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(['user-1']);
    const result = await runReminderSequenceSweep(NOW, 'hourly');
    expect(result.armed).toBe(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'bad', error: 'boom' }),
      'Reminder sequence entity failed'
    );
  });
});

describe('runReminderSequenceSweep — a failing find', () => {
  it('logs the sequence, does not throw, and still returns', async () => {
    mockFind.mockRejectedValue(new Error('find down'));
    await expect(runReminderSequenceSweep(NOW, 'hourly')).resolves.toEqual({
      armed: 0,
      entities: 0,
    });
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sequence: 'proposal_review', error: 'find down' }),
      'Reminder sequence find failed'
    );
  });
});

describe('registerReminderSequenceSweepCron', () => {
  it('registers one hourly repeatable with no custom job id', async () => {
    await registerReminderSequenceSweepCron();
    expect(REMINDER_SEQUENCE_SWEEP_QUEUE).toBe('reminder-sequence-sweep');
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'sweep-hourly',
      { cadence: 'hourly' },
      { repeat: { pattern: REMINDER_SEQUENCE_SWEEP_CRONS.hourly }, removeOnComplete: true }
    );
    expect(REMINDER_SEQUENCE_SWEEP_CRONS.hourly).toBe('20 * * * *');
  });
});
