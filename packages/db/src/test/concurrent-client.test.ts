import { describe, it, expect, vi } from 'vitest';

const captured: Array<Record<string, unknown> | undefined> = [];

vi.mock('postgres', () => ({
  default: (_url: string, options?: Record<string, unknown>) => {
    captured.push(options);
    return { __client: true };
  },
}));
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: () => ({ __db: true }) }));

import { createConcurrentDb } from './concurrent-client';

/**
 * `prepare: false` must reach EVERY caller of the concurrency helper, not just the ones that
 * pass no options.
 *
 * This was a default parameter (`options = { prepare: false }`), which fires only on
 * `undefined` — so any caller passing an options object at all replaced it wholesale and
 * silently inherited postgres-js's `prepare: true`. Three of the helper's four call sites pass
 * options, including both tests that assert the commit-durability invariant ("a 200 must not
 * come with nothing persisted"). Those ran on the one driver configuration this repo declares
 * unsafe — the config under which a COMMIT can silently roll back while the driver reports
 * success — which is precisely the failure they exist to detect.
 */
describe('createConcurrentDb', () => {
  it('passes prepare:false when no options are given', () => {
    captured.length = 0;
    createConcurrentDb('postgres://x');
    expect(captured[0]).toMatchObject({ prepare: false });
  });

  it('KEEPS prepare:false when the caller passes unrelated options', () => {
    // The regression: `{ max: 1 }` used to replace the default wholesale.
    captured.length = 0;
    createConcurrentDb('postgres://x', { max: 1 });
    expect(captured[0]).toMatchObject({ prepare: false, max: 1 });
  });

  it('still lets a caller opt IN to prepare:true deliberately', () => {
    // The one legitimate use: characterising the driver hazard itself.
    captured.length = 0;
    createConcurrentDb('postgres://x', { prepare: true });
    expect(captured[0]).toMatchObject({ prepare: true });
  });
});
