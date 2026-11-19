'use client';

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Which `joinUrl`s currently have a live-cue `JoinMeetingButton` on the page. The top-nav call
 * pill reads it so that it never rings a SECOND control for a meeting whose page-level Join is
 * already ringing (BAL-636: one ring per meeting, whichever surface the viewer is on).
 *
 * A ref-counted map plus listeners, held in a store created once per provider. The context value
 * is that stable store, so a registration never re-renders the tree; only subscribers of
 * `useLiveJoinOnPage` re-render, and only when their own url flips between zero and non-zero.
 */
interface LiveJoinStore {
  register: (joinUrl: string) => () => void;
  isLive: (joinUrl: string) => boolean;
  registerRinging: (joinUrl: string) => () => void;
  isRinging: (joinUrl: string) => boolean;
  subscribe: (listener: () => void) => () => void;
}

function createRefCountedSet(notify: () => void): {
  register: (joinUrl: string) => () => void;
  has: (joinUrl: string) => boolean;
} {
  const counts = new Map<string, number>();
  return {
    register: (joinUrl) => {
      counts.set(joinUrl, (counts.get(joinUrl) ?? 0) + 1);
      notify();
      return () => {
        const next = (counts.get(joinUrl) ?? 0) - 1;
        if (next > 0) counts.set(joinUrl, next);
        else counts.delete(joinUrl);
        notify();
      };
    },
    has: (joinUrl) => (counts.get(joinUrl) ?? 0) > 0,
  };
}

function createStore(): LiveJoinStore {
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const live = createRefCountedSet(notify);
  const ringing = createRefCountedSet(notify);

  return {
    register: live.register,
    isLive: live.has,
    registerRinging: ringing.register,
    isRinging: ringing.has,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const LiveJoinContext = createContext<LiveJoinStore | null>(null);

const NOOP_SUBSCRIBE = (): (() => void) => () => {};

export function LiveJoinRegistryProvider({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const [store] = useState(createStore);
  return <LiveJoinContext.Provider value={store}>{children}</LiveJoinContext.Provider>;
}

/** Publishes `joinUrl` while `enabled` and mounted. Does nothing without a provider. */
export function useLiveJoinRegistration(joinUrl: string, enabled: boolean): void {
  const store = useContext(LiveJoinContext);
  useEffect(() => {
    if (store === null || !enabled) return undefined;
    return store.register(joinUrl);
  }, [store, joinUrl, enabled]);
}

/** True while at least one registered Join on the page targets `joinUrl`. */
export function useLiveJoinOnPage(joinUrl: string | null): boolean {
  const store = useContext(LiveJoinContext);
  return useSyncExternalStore(
    store === null ? NOOP_SUBSCRIBE : store.subscribe,
    () => (store !== null && joinUrl !== null ? store.isLive(joinUrl) : false),
    () => false
  );
}

/**
 * Publishes a RINGING claim on `joinUrl` while `enabled` and mounted: the call toast's Join, for a
 * live Call now ring. Every other Join for the same url then renders static (one moving thing).
 */
export function useRingingJoinRegistration(joinUrl: string, enabled: boolean): void {
  const store = useContext(LiveJoinContext);
  useEffect(() => {
    if (store === null || !enabled) return undefined;
    return store.registerRinging(joinUrl);
  }, [store, joinUrl, enabled]);
}

/** True while a ringing Join claims `joinUrl` on the page. */
export function useRingingJoin(joinUrl: string | null): boolean {
  const store = useContext(LiveJoinContext);
  return useSyncExternalStore(
    store === null ? NOOP_SUBSCRIBE : store.subscribe,
    () => (store !== null && joinUrl !== null ? store.isRinging(joinUrl) : false),
    () => false
  );
}
