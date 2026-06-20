import { describe, it, expect, vi, beforeEach } from 'vitest';

// The seam imports `next/server` `after()` and the `@balo/analytics/server` barrel
// (which pulls in posthog-node). Both are mocked so the unit test stays pure — we
// only assert the seam's WIRING: enqueue with trackServer, then schedule the flush
// via after(). `server-only` is aliased to a stub in vitest.config.ts, so the
// `import 'server-only'` at the top of the seam resolves without throwing.
const { mockAfter, mockTrackServer, mockFlush } = vi.hoisted(() => ({
  mockAfter: vi.fn(),
  mockTrackServer: vi.fn(),
  mockFlush: vi.fn(),
}));

vi.mock('next/server', () => ({ after: mockAfter }));
vi.mock('@balo/analytics/server', () => ({
  trackServer: mockTrackServer,
  flushServerAnalytics: mockFlush,
  PROJECT_SERVER_EVENTS: { REQUEST_ACCESS_DENIED: 'project_request_access_denied' },
}));

import { trackServerAndFlush } from './server';

const EVENT = 'project_request_access_denied' as const;
const PROPS = {
  request_id: 'req-1',
  reason: 'declined_relationship',
  lens_attempted: 'expert',
  distinct_id: 'user-1',
} as const;

describe('trackServerAndFlush', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues the event via trackServer once with the event + props', () => {
    trackServerAndFlush(EVENT, PROPS);

    expect(mockTrackServer).toHaveBeenCalledTimes(1);
    expect(mockTrackServer).toHaveBeenCalledWith(EVENT, PROPS);
  });

  it('schedules the flush via next/server after() exactly once', () => {
    trackServerAndFlush(EVENT, PROPS);

    expect(mockAfter).toHaveBeenCalledTimes(1);
  });

  it('passes the flush by reference to after(), and that callback triggers the flush', () => {
    trackServerAndFlush(EVENT, PROPS);

    // The seam passes `flushServerAnalytics` directly — after() receives the
    // flush function itself, not a wrapper.
    expect(mockAfter).toHaveBeenCalledWith(mockFlush);

    // Belt-and-braces: invoking the captured callback must trigger the flush.
    const [firstCall] = mockAfter.mock.calls;
    if (firstCall === undefined) {
      throw new Error('after() was not called');
    }
    const [scheduled] = firstCall;
    if (typeof scheduled !== 'function') {
      throw new Error('after() was not called with a function');
    }
    scheduled();
    expect(mockFlush).toHaveBeenCalledTimes(1);
  });
});
