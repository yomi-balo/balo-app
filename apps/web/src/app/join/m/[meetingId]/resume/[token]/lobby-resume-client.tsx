'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { LOBBY_TOKEN_STORAGE_KEY, LOBBY_WAIT_STARTED_STORAGE_KEY } from '@/lib/meetings/lobby';

/**
 * BAL-442 — writes the resume link's raw token into the lobby's own `sessionStorage` keys,
 * then replaces into the clean lobby URL so the credential leaves this TAB'S BACK STACK.
 *
 * ⚠⚠ CORRECTION A — THE KEYS ARE NAMESPACED PER MEETING, AND DERIVED FROM THE EXPORTED
 * CONSTANTS, NEVER HARDCODED. `lobby-client.tsx`'s resume effect reads
 * `${LOBBY_TOKEN_STORAGE_KEY}:${meetingId}` / `${LOBBY_WAIT_STARTED_STORAGE_KEY}:${meetingId}`
 * — writing the bare, un-namespaced key is a SILENT NO-OP: the feature would appear to work
 * (this page still redirects) and recover nothing (the lobby never sees the token).
 *
 * ⚠⚠ THE WAIT-START KEY IS WRITTEN TOO, AND IT IS NOT DECORATION. `sessionStorage` survives
 * WITHIN a tab, so a guest who waited earlier in THIS SAME TAB still has a stale
 * `balo.lobby-waiting-since:<id>` from hours ago — the lobby's resume effect would restore it
 * as `waitingSince`, jumping the poll straight to the 15s back-off and firing the long-wait
 * copy immediately. Overwriting it with `now` is the honest anchor: the original wait's start
 * instant died with the tab that held it.
 *
 * ⚠ `router.replace`, NEVER `router.push` — `replace` keeps the token-bearing URL out of this
 * tab's BACK STACK, so a Back press lands on the clean lobby rather than re-entering on the
 * credential. ⚠ fix round (R-7) — IT DOES **NOT** ERASE THE VISIT. The page was reached by a
 * real navigation, so the browser's own history (and, on a signed-in profile, its sync) already
 * holds the token-bearing URL, exactly as it would for a `/join/{token}` landing: the exposure
 * of the two forms is EQUAL, and the earlier "does not persist in browser history" wording
 * claimed more than `replace` can deliver. What the PATH form buys over a `?rt=` query string
 * is server-side — `redactSensitivePathPrefixes` covers it (BLOCKER B) — not client-side.
 * A hard `location.replace` is NOT needed here the way BAL-566's join
 * button needs a hard navigation: that case goes from a NON-sensitive page into a sensitive
 * one, and `instrumentation-client.ts` decides Session Replay by URL at `Sentry.init()` time.
 * Here BOTH the origin (`/join/m/{id}/resume/{token}`) and the destination (`/join/m/{id}`)
 * are sensitive landings (`isSensitiveUrl` is `true` for both after BLOCKER B's redaction fix),
 * so Replay was never started and a soft navigation cannot carry one in.
 *
 * ⚠ NO `<Link>` AND NO `<a href>` ANYWHERE IN THIS SUBTREE, and no `/join/` literal in the
 * comment-stripped source of any file under it — `join-link-never-writes.test.ts` pins both.
 */

interface LobbyResumeClientProps {
  readonly meetingId: string;
  readonly token: string;
  /** ⚠ A PLAIN STRING FROM THE SERVER — see `lobbyPath`'s docblock (BLOCKER C). */
  readonly destination: string;
}

type ResumeState = 'working' | 'blocked';

/** ⚠ Storage can THROW on access in a locked-down profile (Safari private mode), not merely
 *  return null/no-op. Returns whether the write actually landed. */
function writeStorage(key: string, value: string): boolean {
  try {
    globalThis.sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function LobbyResumeClient({
  meetingId,
  token,
  destination,
}: Readonly<LobbyResumeClientProps>): React.JSX.Element {
  const [state, setState] = useState<ResumeState>('working');
  const router = useRouter();
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    // ⚠ `globalThis.window === undefined`, NOT `typeof … === 'undefined'` (SonarJS
    // no-typeof-undefined) — the lobby client's own rule.
    if (globalThis.window === undefined) return;

    const tokenKey = `${LOBBY_TOKEN_STORAGE_KEY}:${meetingId}`;
    const waitStartKey = `${LOBBY_WAIT_STARTED_STORAGE_KEY}:${meetingId}`;

    const wroteToken = writeStorage(tokenKey, token);
    // ⚠ WRITTEN EVEN THOUGH THE TOKEN WRITE MAY HAVE FAILED — if storage is blocked, this call
    // will fail identically and is harmless; if it somehow succeeds while the token write
    // failed, leaving a stale wait-start behind is a strictly worse residual than overwriting
    // it, so there is no ordering hazard either way.
    writeStorage(waitStartKey, String(Date.now()));

    if (!wroteToken) {
      // ⚠ STORAGE IS BLOCKED. Redirecting now would drop the visitor back on the knock form
      // with no token — i.e. re-lock them out with no explanation.
      setState('blocked');
      return;
    }
    router.replace(destination);
  }, [destination, meetingId, router, token]);

  const isReduced = reduceMotion === true;

  if (state === 'blocked') {
    return (
      <div className="border-border bg-card mx-auto w-full max-w-md rounded-2xl border p-8 text-center shadow-sm">
        <span className="border-border bg-muted/40 mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border">
          <AlertTriangle className="text-muted-foreground h-6 w-6" aria-hidden="true" />
        </span>
        <h1 className="text-foreground mt-4 text-lg font-semibold">
          This browser is blocking storage
        </h1>
        <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
          Open the link from your email again in a normal (not private) window.
        </p>
        <p className="text-muted-foreground border-border mt-6 border-t pt-4 text-[11.5px]">
          Powered by <span className="text-foreground font-semibold">Balo</span>
        </p>
      </div>
    );
  }

  return (
    <motion.div
      initial={isReduced ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: isReduced ? 0 : 0.18 }}
      className="border-border bg-card mx-auto w-full max-w-md rounded-2xl border p-8 text-center shadow-sm"
    >
      <span className="border-border bg-muted/40 mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" aria-hidden="true" />
      </span>
      <h1 tabIndex={-1} className="text-foreground mt-4 text-lg font-semibold">
        Getting you back in…
      </h1>
      <output className="sr-only">Getting you back in…</output>
      <p className="text-muted-foreground border-border mt-6 border-t pt-4 text-[11.5px]">
        Powered by <span className="text-foreground font-semibold">Balo</span>
      </p>
    </motion.div>
  );
}
