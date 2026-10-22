'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AVAILABILITY_CACHE_TTL_SECONDS,
  type AvailabilityScope,
  type AvailabilitySlotDto,
} from '@balo/shared/availability';

/**
 * BAL-236 — the fetch state machine for the public availability endpoint.
 *
 * Ruling (plan §4.2): a purpose-built hook over bare `fetch`, NOT react-query. `QueryProvider`
 * is mounted app-wide but has zero consumers anywhere in `apps/web/src`, and the state machine
 * here must treat 404, 503-`unavailable`, and 500 differently and must NOT auto-retry a 404 —
 * whereas react-query's default `retry: 1` would. The repo's actual precedent for
 * browser→Fastify is bare `fetch` against `NEXT_PUBLIC_API_URL`
 * (`expert/settings/_components/payouts-tab.tsx`).
 */
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002';

export type AvailabilityView =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      slots: AvailabilitySlotDto[];
      expertTimezone: string;
      days: number;
      /** Epoch ms on THIS browser's clock when the response arrived; drives the stale-tab refresh.
       *  Never the server's `generatedAt`, so a skewed device clock can't force or suppress it.
       *  Always set by this hook. */
      receivedAt?: number;
    }
  | { kind: 'not_configured' }
  | { kind: 'empty_window'; days: number } // status 'no_slots'
  | { kind: 'unavailable' } // 503 — calendar unreachable, retryable
  | { kind: 'paused' } // 200 `paused` — the expert has paused new work (scope `new_work` only)
  | { kind: 'not_published' } // 404 — profile not approved+searchable
  | { kind: 'error' }; // network / 4xx / 5xx

interface AvailabilityOkBody {
  expertProfileId: string;
  status: 'ok' | 'not_configured' | 'no_slots';
  expertTimezone: string;
  generatedAt: string;
  windowEnd: string;
  days: number;
  slots: AvailabilitySlotDto[];
}

/**
 * How long the browser waits before giving up. Without it a black-holed connection leaves the
 * skeleton on screen forever with no retry affordance — `fetch` has no default timeout.
 */
const REQUEST_TIMEOUT_MS = 15_000;

function isSlotDto(value: unknown): value is AvailabilitySlotDto {
  if (typeof value !== 'object' || value === null) return false;
  const slot = value as Partial<AvailabilitySlotDto>;
  if (typeof slot.start !== 'string' || typeof slot.end !== 'string') return false;
  if (typeof slot.maxDuration !== 'number') return false;
  // ⚠ THE PARSE IS PART OF THE GUARD. An unparseable instant survives a shape-only check and
  // then throws a RangeError during render, inside a `useMemo`, which the route's error boundary
  // escalates to replacing the ENTIRE settings page rather than just the calendar.
  return (
    Number.isFinite(new Date(slot.start).getTime()) && Number.isFinite(new Date(slot.end).getTime())
  );
}

/**
 * ⚠ VALIDATES WHAT IT ASSERTS. The earlier version type-asserted `AvailabilityOkBody` while
 * checking only "`status` is some string, `slots` is some array" — so an UNRECOGNISED status
 * fell through to the `ready` branch (the client's fail-closed discipline resting entirely on
 * the server never emitting one) and `slots: [garbage]` reached the renderer.
 */
function isAvailabilityOkBody(value: unknown): value is AvailabilityOkBody {
  if (typeof value !== 'object' || value === null) return false;
  const body = value as Partial<AvailabilityOkBody>;
  if (body.status !== 'ok' && body.status !== 'not_configured' && body.status !== 'no_slots') {
    return false;
  }
  if (typeof body.expertTimezone !== 'string') return false;
  if (typeof body.days !== 'number' || !Number.isFinite(body.days)) return false;
  return Array.isArray(body.slots) && body.slots.every(isSlotDto);
}

/** The `paused` body carries no slots, so it is recognised before the slot-bearing allow-list. */
function isPausedBody(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { status?: unknown }).status === 'paused'
  );
}

/**
 * A ready grid held on the page for longer than this is refetched when the tab returns. A grid
 * can already be up to two cache lifetimes old when it lands (server cache, then the browser's),
 * so a refresh keeps what's on screen within four.
 */
const STALE_AFTER_MS = 2 * AVAILABILITY_CACHE_TTL_SECONDS * 1000;

/** Maps a response to the view it represents. Shared by the loading fetch and the silent one. */
async function viewFromResponse(res: Response): Promise<AvailabilityView> {
  if (res.status === 404) return { kind: 'not_published' };
  if (res.status === 503) return { kind: 'unavailable' };
  if (!res.ok) return { kind: 'error' };
  const body: unknown = await res.json();
  if (isPausedBody(body)) return { kind: 'paused' };
  if (!isAvailabilityOkBody(body)) return { kind: 'error' };
  if (body.status === 'not_configured') return { kind: 'not_configured' };
  // Belt-and-braces for the server's own "derive status after the window filter" rule: an `ok`
  // with nothing in it is an empty window, never a renderable calendar.
  if (body.status === 'no_slots' || body.slots.length === 0) {
    return { kind: 'empty_window', days: body.days };
  }
  return {
    kind: 'ready',
    slots: body.slots,
    expertTimezone: body.expertTimezone,
    days: body.days,
    receivedAt: Date.now(),
  };
}

function availabilityUrl(expertProfileId: string, days: number, scope: AvailabilityScope): string {
  /**
   * ⚠ THE ID IS ENCODED AND `days` GOES THROUGH `URLSearchParams`. The server validates the id
   * as a uuid, but a consumer passing one containing `/`, `?` or `#` would otherwise re-target
   * the request at a different path entirely before the server ever sees it.
   */
  const url = new URL(`${API_BASE}/experts/${encodeURIComponent(expertProfileId)}/availability`);
  url.searchParams.set('days', String(days));
  url.searchParams.set('scope', scope);
  return url.toString();
}

/**
 * `scope` says which kind of work the grid is read for. `new_work` (the default and the
 * fail-safe) answers `paused` for an expert who has paused new work; `existing_work` always
 * serves the real grid (follow-ups, intro calls, reschedules).
 */
export function useExpertAvailability(
  expertProfileId: string,
  days: number,
  scope: AvailabilityScope = 'new_work',
  skipFetch = false
): { view: AvailabilityView; reload: () => void } {
  const [view, setView] = useState<AvailabilityView>({ kind: 'loading' });
  const [nonce, setNonce] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const reload = useCallback((): void => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    // The caller already knows the profile isn't publicly visible, so the public endpoint would
    // only answer its concealing 404; resolve to that same state without the request.
    if (skipFetch) {
      setView({ kind: 'not_published' });
      return undefined;
    }

    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    setView({ kind: 'loading' });

    const url = availabilityUrl(expertProfileId, days, scope);

    /**
     * ⚠ EVERY COMMIT IS GUARDED BY `signal.aborted`. `AbortController` cancels the *request*,
     * but once `res.json()` has resolved a later `abort()` rejects nothing — the queued
     * continuation still runs and still calls `setView`. Expert A's slots would then overwrite
     * the `{ kind: 'loading' }` expert B's effect just set, rendering A's availability under B's
     * identity. Latent while the only shipped consumer passes a fixed id; live the moment a
     * search drawer swaps the prop without a `key`.
     */
    const commit = (next: AvailabilityView): void => {
      if (controller.signal.aborted) return;
      setView(next);
    };

    fetch(url, {
      signal: controller.signal,
      // Retries (`reload()`, via `nonce`) bypass the browser HTTP cache; the initial fetch
      // deliberately does NOT set `cache: 'no-store'` — we WANT the browser to honour the
      // server's `max-age=60`.
      cache: nonce > 0 ? 'reload' : undefined,
    })
      .then(async (res) => {
        commit(await viewFromResponse(res));
      })
      .catch((error: unknown) => {
        // A timeout aborts too — but it is a failure the user must be able to retry from, not a
        // supersession, so it is the one abort that still commits.
        if (timedOut) {
          setView({ kind: 'error' });
          return;
        }
        if (error instanceof DOMException && error.name === 'AbortError') return;
        commit({ kind: 'error' });
      })
      .finally(() => {
        clearTimeout(timer);
      });

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [expertProfileId, days, scope, nonce, skipFetch]);

  // A ready grid left on screen for longer than it could have been cached is refetched when the
  // tab returns. Silent: the current view keeps rendering until the answer lands, and a failed
  // refresh leaves it in place (the pickers also drop any slot whose start has passed).
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    if (skipFetch) return undefined;
    let controller: AbortController | null = null;

    const refreshIfStale = (): void => {
      const current = viewRef.current;
      if (controller !== null || current.kind !== 'ready') return;
      if (current.receivedAt === undefined) return;
      if (Date.now() - current.receivedAt <= STALE_AFTER_MS) return;
      const own = new AbortController();
      controller = own;
      fetch(availabilityUrl(expertProfileId, days, scope), {
        signal: own.signal,
        cache: 'reload',
      })
        .then(viewFromResponse)
        .then((next) => {
          if (own.signal.aborted || viewRef.current.kind !== 'ready') return;
          if (next.kind === 'error' || next.kind === 'unavailable') return;
          setView(next);
        })
        .catch(() => undefined)
        .finally(() => {
          if (controller === own) controller = null;
        });
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refreshIfStale();
    };

    document.addEventListener('visibilitychange', onVisibility);
    globalThis.addEventListener('focus', refreshIfStale);
    globalThis.addEventListener('pageshow', refreshIfStale);
    return () => {
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
      globalThis.removeEventListener('focus', refreshIfStale);
      globalThis.removeEventListener('pageshow', refreshIfStale);
    };
  }, [expertProfileId, days, scope, skipFetch]);

  return { view, reload };
}
