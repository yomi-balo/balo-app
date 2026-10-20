'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

type Handler = () => void;
type Register = (handler: Handler | null) => void;
type RegisterPending = (pending: boolean) => void;

// Two contexts so the registering side (the stage) never re-renders when the handler it
// registered lands in state — only the invoking side reads that.
const RegisterContext = createContext<Register | null>(null);
const HandlerContext = createContext<Handler | null>(null);
const RegisterPendingContext = createContext<RegisterPending | null>(null);
const PendingContext = createContext(false);

/**
 * Lets the page nudge's "Propose times" run the conversation stage's OWN call handler.
 *
 * The stage owns the expert's share-availability flow and its optimistic thread state (the
 * "Availability shared" pill, the thread nudge's waiting cell). A second caller of the share
 * action outside the stage would leave that state stale and re-stamp the row on every click, so
 * the page nudge never calls the action itself: the stage registers its handler here and the
 * nudge invokes it. With no stage mounted (no registration), the nudge's button stays disabled.
 * The stage also reports whether that call is in flight, so the nudge can show the same pending
 * state the stage's own buttons do.
 */
export function ExpertCallBridgeProvider({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const [handler, setHandler] = useState<Handler | null>(null);
  const [pending, setPending] = useState(false);
  // The updater form: a bare function argument to a state setter is called, not stored.
  const register = useCallback<Register>((next) => setHandler(() => next), []);
  return (
    <RegisterContext.Provider value={register}>
      <RegisterPendingContext.Provider value={setPending}>
        <HandlerContext.Provider value={handler}>
          <PendingContext.Provider value={pending}>{children}</PendingContext.Provider>
        </HandlerContext.Provider>
      </RegisterPendingContext.Provider>
    </RegisterContext.Provider>
  );
}

/**
 * The stage side: expose `handler` while mounted and non-null. Registers ONE stable forwarder
 * that always calls the latest `handler`, so a handler whose identity changes between renders
 * never re-registers (and never re-renders the provider in a loop).
 */
export function useRegisterExpertProposeTimes(handler: Handler | null, pending = false): void {
  const register = useContext(RegisterContext);
  const registerPending = useContext(RegisterPendingContext);
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  const enabled = handler !== null;
  useEffect(() => {
    if (register === null || !enabled) return undefined;
    register(() => latest.current?.());
    return () => register(null);
  }, [register, enabled]);
  useEffect(() => {
    if (registerPending === null) return undefined;
    registerPending(pending);
    return () => registerPending(false);
  }, [registerPending, pending]);
}

/** The nudge side: the registered handler, or `null` when no stage offers one. */
export function useExpertProposeTimes(): Handler | null {
  return useContext(HandlerContext);
}

/** The nudge side: whether the registered handler's call is currently in flight. */
export function useExpertProposeTimesPending(): boolean {
  return useContext(PendingContext);
}
