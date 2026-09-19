import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
// @ts-expect-error — Next's vendored Flight server ships no type declarations. It is used here
// instead of a new `react-server-dom-webpack` devDependency because it is already on disk via
// `next`, and a separately-installed copy would have to be kept version-locked to React by hand.
import { renderToReadableStream } from 'next/dist/compiled/react-server-dom-webpack/server.node.js';

/**
 * BAL-568 fix round 3 (H2) — **WHAT `React.cache()` DOES, MEASURED IN THE WORLD THE APP RUNS IN.**
 *
 * ⚠⚠ WHY THIS FILE EXISTS RATHER THAN MORE ASSERTIONS IN `live-user.test.ts`. That suite runs
 * under the DEFAULT vitest project, which resolves `react` with no `react-server` condition — so
 * it loads React's CLIENT build, where `cache` is literally
 * `function (fn) { return function () { return fn.apply(null, arguments); }; }`: a pass-through.
 * Its `toHaveBeenCalledTimes(2)` therefore passes whether or not production dedupes; it pins that
 * `readLiveUserRow` adds no memo of its OWN (real, and still worth having) and nothing about
 * React. This file loads the **`react-server`** build and drives a real **Flight render**, which
 * is the only place a `cache()` scope exists — so here the two-read claim can actually fail.
 *
 * It runs under its own vitest project, `apps/web/vitest.rsc.config.ts`, which the root
 * `vitest.config.ts` lists beside `apps/web`. The default web project EXCLUDES every
 * `.react-server.test.ts` suite, because under the client build the Flight renderer refuses to start
 * ("The `react` package in this environment is not configured correctly") — which is also why
 * this suite cannot silently degrade into testing the wrong world: it fails loudly instead.
 *
 * ⚠ THE RESULT, MEASURED 2026-09-19, CONFIRMS THE DOCBLOCKS IT PINS (`./live-user.ts`,
 * `./session.ts`, `./account-liveness.ts`, `invariants/live-row-single-reader.test.ts`): two calls
 * OUTSIDE a render are TWO reads; two calls INSIDE one render are ONE; and two SEPARATE renders do
 * not share. Nothing was adjusted to make them agree.
 */

const mockFindForSessionSync = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: {
    findForSessionSync: (...args: unknown[]) => mockFindForSessionSync(...args),
  },
}));

import { readLiveUserRow } from './live-user';

const ROW = { status: 'active', deletedAt: null };

/** A server component: it may await, and its return value is serialized into the Flight stream. */
type ServerComponent = () => Promise<unknown>;

/**
 * Render `Component` through a real Flight pass and drain the stream, so the component has
 * definitely run by the time this resolves. Returns the number of stream chunks — a non-zero
 * count is the proof that a render actually happened (RS1), rather than the harness quietly
 * doing nothing and every "one read" assertion below passing vacuously.
 */
async function renderInFlight(Component: ServerComponent): Promise<number> {
  const element = createElement(Component as unknown as () => null);
  const stream: ReadableStream<Uint8Array> = renderToReadableStream(element, {});
  const reader = stream.getReader();
  let chunks = 0;
  for (;;) {
    const { done } = await reader.read();
    if (done) return chunks;
    chunks += 1;
  }
}

describe('readLiveUserRow under the react-server build (BAL-568 / H2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindForSessionSync.mockResolvedValue(ROW);
  });

  it('RS1: the Flight harness really renders — the component body runs exactly once', async () => {
    let bodyRuns = 0;
    const chunks = await renderInFlight(async () => {
      bodyRuns += 1;
      return 'ok';
    });

    expect(bodyRuns, 'the harness must actually invoke the component').toBe(1);
    expect(chunks, 'a real render emits at least one Flight chunk').toBeGreaterThan(0);
  });

  /**
   * ⚠ OUTSIDE A RENDER PASS THERE IS NO CACHE SCOPE, so `cache()` invokes the inner function every
   * time. This is the state a **Server Action** and a **Route Handler** are in — which is why the
   * 22 platform-gated staff actions pay TWO primary-key reads (the liveness gate, then
   * `actorHoldsPlatformCapability`). That cost was RULED ACCEPTABLE (user, 2026-09-19).
   */
  it('RS2: ⚠ two calls OUTSIDE a render pass are TWO reads', async () => {
    await readLiveUserRow('user-1');
    await readLiveUserRow('user-1');

    expect(mockFindForSessionSync).toHaveBeenCalledTimes(2);
    // Both carried the identical key, so a memo keyed on the argument WOULD have collapsed them.
    expect(mockFindForSessionSync.mock.calls).toEqual([['user-1'], ['user-1']]);
  });

  /**
   * ⚠⚠ THE HALF THAT MAKES THIS SUITE ABLE TO TELL THE TWO WORLDS APART. Under the client build
   * `cache` is a pass-through and this would read twice; under the react-server build inside a
   * render it reads once. It is what proves RS2's two reads are the MISSING RENDER SCOPE rather
   * than a cache-key miss or a `cache()` that never worked at all — and it is what makes the
   * "a page render shares one round trip" half of `./live-user.ts`'s docblock a measured claim.
   */
  it('RS3: ⚠⚠ two calls INSIDE one render pass are ONE read', async () => {
    const seen: unknown[] = [];
    await renderInFlight(async () => {
      seen.push(await readLiveUserRow('user-1'));
      seen.push(await readLiveUserRow('user-1'));
      return 'ok';
    });

    // The component really made two calls, and both got the same row back from one read.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(ROW);
    expect(seen[1]).toBe(ROW);
    expect(mockFindForSessionSync).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠⚠ THE SCOPE IS ONE RENDER, NOT THE PROCESS — and for a LIVENESS read that is a security
   * property, not a performance note: a memo that outlived the request would let a suspended
   * account keep passing the gate on the strength of a read taken before it was suspended.
   */
  it('RS4: ⚠ two SEPARATE renders do not share a read', async () => {
    const readOnce: ServerComponent = async () => {
      await readLiveUserRow('user-1');
      return 'ok';
    };

    await renderInFlight(readOnce);
    await renderInFlight(readOnce);

    expect(mockFindForSessionSync).toHaveBeenCalledTimes(2);
  });
});
