'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface ResolveDismissalState {
  /** The client answered “not yet” during THIS page session. */
  dismissed: boolean;
  markDismissed: () => void;
}

/**
 * BAL-388 §R4/§R9 — ONE session-scoped answer to “did the client already say not yet?”,
 * owned ABOVE both prompts.
 *
 * ⚠⚠ THIS EXISTS BECAUSE DISMISSAL IS A SERVER MUTATION. `dismissResolutionRequestAction`
 * CLEARS the paired `resolution_requested_*` columns and revalidates, so the very next server
 * render of this page returns `variant: 'offered'` — and the client composition then fills the
 * §R9 wrap-up slot. Left ungated, pressing “Not yet” on the R4 banner re-asked the SAME
 * question two inches lower, in the same breath. Local state inside the banner cannot fix that:
 * the banner UNMOUNTS on the refresh and the card MOUNTS, so the answer has to live somewhere
 * that survives both. It lives here. `router.refresh()` reconciles this provider in place, so
 * the state survives the RSC payload swap; a FULL reload legitimately clears it, which is the
 * intended scope — the owner decision (D-E) is “not again in this session”, not “never again”.
 *
 * ⚠ NEUTRAL BY DEFAULT. With no provider above it the context reads `dismissed: false`, so
 * the EXPERT composition (which mounts no provider and no prompt at all) and every isolated
 * component test render exactly as before.
 */
const ResolveDismissalContext = createContext<ResolveDismissalState>({
  dismissed: false,
  markDismissed: () => undefined,
});

export function useResolveDismissal(): ResolveDismissalState {
  return useContext(ResolveDismissalContext);
}

/** Wraps the CLIENT composition (see `client-recap.tsx`). The expert lens mounts none. */
export function ResolveDismissalProvider({
  children,
}: Readonly<{ children: ReactNode }>): React.JSX.Element {
  const [dismissed, setDismissed] = useState(false);
  const markDismissed = useCallback(() => setDismissed(true), []);
  const value = useMemo(() => ({ dismissed, markDismissed }), [dismissed, markDismissed]);
  return (
    <ResolveDismissalContext.Provider value={value}>{children}</ResolveDismissalContext.Provider>
  );
}

/**
 * Renders `children` unless the resolve question was dismissed in this page session.
 *
 * ⚠ IT WRAPS THE `Reveal`, NOT THE CARD, AND THAT IS THE POINT. A gate INSIDE the prompt
 * would return `null` while its wrapper stayed behind as a grid child — the dead-gap defect
 * the slots are passed as `undefined` to avoid. Removing the wrapper too is the whole job.
 */
export function UnlessDismissed({
  children,
}: Readonly<{ children: ReactNode }>): React.JSX.Element | null {
  const { dismissed } = useResolveDismissal();
  if (dismissed) return null;
  return <>{children}</>;
}
