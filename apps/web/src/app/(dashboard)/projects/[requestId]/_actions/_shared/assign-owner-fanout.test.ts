import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { runAfterResponseMock, getScheduled } = vi.hoisted(() => {
  let scheduled: (() => Promise<void>) | null = null;
  return {
    runAfterResponseMock: vi.fn((_label: string, work: () => Promise<void>) => {
      scheduled = work;
    }),
    getScheduled: (): (() => Promise<void>) | null => scheduled,
  };
});

vi.mock('@/lib/after-response', () => ({
  runAfterResponse: runAfterResponseMock,
}));

const mockPublishNow = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEventNow: (...args: unknown[]) => mockPublishNow(...args),
}));

import { runAssignOwnerFanout } from './assign-owner-fanout';

const CONTEXT = {
  correlationId: 'audit-1',
  projectRequestId: 'request-1',
  newOwnerUserId: 'owner-1',
  assignedByUserId: 'admin-1',
  title: 'CPQ implementation',
  clientCompanyName: 'Acme Corp',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runAssignOwnerFanout', () => {
  it('defers the publish via runAfterResponse rather than running inline', () => {
    runAssignOwnerFanout(CONTEXT);

    expect(runAfterResponseMock).toHaveBeenCalledWith('assign owner fan-out', expect.any(Function));
    expect(mockPublishNow).not.toHaveBeenCalled();
  });

  it('publishes project.request_owner_assigned with the context mapped onto the payload shape', async () => {
    runAssignOwnerFanout(CONTEXT);
    await getScheduled()?.();

    expect(mockPublishNow).toHaveBeenCalledWith('project.request_owner_assigned', {
      correlationId: 'audit-1',
      projectRequestId: 'request-1',
      userId: 'owner-1',
      assignedByUserId: 'admin-1',
      title: 'CPQ implementation',
      clientCompanyName: 'Acme Corp',
    });
  });

  it('performs no read of its own — the mocked module exposes only the publisher', async () => {
    // If this fan-out ever grew a repository read, importing `@balo/db` here (unmocked) would
    // throw at module load — the module-resolution equivalent of `close-request-fanout.test.ts`'s
    // "explode on contact" guard.
    runAssignOwnerFanout(CONTEXT);
    await getScheduled()?.();
    expect(mockPublishNow).toHaveBeenCalledTimes(1);
  });
});
