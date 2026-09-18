'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, Loader2, Mail } from 'lucide-react';
import { toast } from 'sonner';
import {
  LOBBY_REENTRY_EMAIL_LABEL,
  LOBBY_REENTRY_HELPER,
  LOBBY_REENTRY_NEUTRAL_MESSAGE,
  LOBBY_REENTRY_SUBMIT_LABEL,
  LOBBY_REENTRY_SUBMITTING_LABEL,
  LOBBY_REENTRY_TRANSPORT_ERROR,
  LOBBY_REENTRY_TRIGGER_LABEL,
} from '@/lib/meetings/lobby';
// ⚠ C5 — A RELATIVE IMPORT, matching `lobby-client.tsx`'s own convention: `_actions` sits at
// `app/join/_actions`, this route is `app/join/m/[meetingId]`. Never the `@/app/join/` alias
// and never a hardcoded `/join/` literal — `join-link-never-writes.test.ts` bans both in this
// tree.
import { requestLobbyReentryLinkAction } from '../../_actions/request-lobby-reentry-link';

/**
 * BAL-442 (RULING 2) — the lobby's self-service RE-ENTRY affordance: "Already asked to join?
 * Email me my link", mounted beneath the knock form by `LobbyIdentify`.
 *
 * ⚠⚠ AN ALWAYS-RENDERED TRIGGER. It renders on first paint, before any server call, and is
 * NEVER conditional on whether a pending row exists — the affordance itself would otherwise
 * become the existence oracle. The guest recovers WITHOUT having to fail a knock first.
 *
 * The collapsed→expanded PANEL is the only conditional thing, and it is conditional on the
 * visitor's own click, which discloses nothing. Keeping a second email input off the screen by
 * default avoids a two-visible-inputs layout while still satisfying "persistent,
 * always-rendered".
 *
 * ⚠ THE SUCCESS COPY IS THE NEUTRAL CONSTANT, rendered IDENTICALLY for a match and a miss —
 * see `LOBBY_REENTRY_NEUTRAL_MESSAGE`'s own docblock. ⚠ NO CLIENT-SIDE COOLDOWN — the four
 * server-side rate-limit windows are the control; a client timer here would be a false one.
 *
 * ⚠ NO `@balo/db` VALUE IMPORT ANYWHERE IN THIS FILE (bundle footgun; pinned by
 * `join-link-never-writes.test.ts`).
 */

interface LobbyReentryProps {
  readonly meetingId: string;
  /**
   * Seeds the panel's input so the visitor types their address once, not twice.
   * ⚠ APPLIED ON EXPAND, NOT ON MOUNT — see {@link handleToggle}'s docblock (R-3).
   */
  readonly defaultEmail: string;
  readonly reduceMotion: boolean;
}

type SubmitState = 'idle' | 'submitting' | 'success' | 'invalid_input' | 'unavailable';

export function LobbyReentry({
  meetingId,
  defaultEmail,
  reduceMotion,
}: Readonly<LobbyReentryProps>): React.JSX.Element {
  const [isExpanded, setIsExpanded] = useState(false);
  const [email, setEmail] = useState(defaultEmail);
  const [state, setState] = useState<SubmitState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // ⚠ F15 — where focus lands once the success message renders, so a keyboard/screen-reader
  // user is not stranded on a submit button that just unmounted.
  // ⚠ `<output>`, NOT `role="status"` — SonarCloud S6819 flags the ARIA role where a native
  // element exists (escapes local lint; see `resume/[token]/loading.tsx`), and `<output>`
  // carries the same implicit live-region semantics natively.
  const successStatusRef = useRef<HTMLOutputElement>(null);

  // ⚠ FIXED LITERAL IDS, NOT `useId()`. React's per-ROOT id prefix means two SEPARATE
  // `render()` calls (as `lobby-client.test.tsx`'s byte-identity test performs, mounting and
  // unmounting across four failing paths) mint DIFFERENT ids for the same tree shape — which
  // broke that test's `container.innerHTML` comparison. This component is mounted at most once
  // per page, so a fixed id carries no collision risk here.
  const panelId = 'lobby-reentry-panel';
  const errorId = 'lobby-reentry-error';

  /**
   * ⚠⚠ fix round (R-3) — SEED FROM THE KNOCK FORM **ON EXPAND**, NOT ON MOUNT. `useState`'s
   * argument is an INITIAL value, read once. This component mounts on first paint (it is the
   * ALWAYS-RENDERED trigger, RULING 2), when the knock form's `email` is still the empty
   * string — so `useState(defaultEmail)` captured `''` and never saw a keystroke after it, and
   * an address typed a few pixels above did NOT appear here. It only ever LOOKED right in the
   * terminal `unavailable` state, which happens to be a FRESH MOUNT.
   *
   * ⚠ ONLY WHEN THE PANEL'S OWN VALUE IS EMPTY, so a visitor who deliberately typed a DIFFERENT
   * address in here (the "I used my other address" case "Try a different address" exists for)
   * never has it overwritten by collapsing and re-expanding.
   *
   * ⚠ NOT A `useEffect` SYNC ON `defaultEmail` — that would re-seed on every keystroke in the
   * knock form while the panel is open, fighting the visitor for their own input.
   */
  const handleToggle = useCallback(() => {
    if (!isExpanded) {
      setEmail((current) => (current.length === 0 ? defaultEmail : current));
    }
    setIsExpanded((current) => !current);
  }, [defaultEmail, isExpanded]);

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (state === 'submitting') return;

      setState('submitting');
      setErrorMessage(null);
      // ⚠ DELIBERATELY NOT AWAITED — a React event handler must stay synchronous, and every
      // outcome is handled in the chain below. ⚠ NOT PREFIXED WITH `void` — `lobby-client.tsx`'s
      // rule verbatim: this repo's ESLint config does not enable type-aware linting, so
      // `no-floating-promises` never fires, while SonarCloud S3735 flags the operator.
      requestLobbyReentryLinkAction({ meetingId, email })
        .then((result) => {
          if (!result.success) {
            if (result.kind === 'invalid_input') {
              setState('invalid_input');
              setErrorMessage(result.error);
              return;
            }
            setState('unavailable');
            setErrorMessage(result.error);
            toast.error(result.error);
            return;
          }
          setState('success');
          toast.success(result.message);
        })
        .catch(() => {
          // ⚠⚠ F1 — A DROPPED CONNECTION IS NOT A SUCCESS. The request may never have reached
          // the server, so rendering `LOBBY_REENTRY_NEUTRAL_MESSAGE` here would be an outright
          // lie: it claims "we've sent a new link" when nothing was sent, and the guest waits
          // for an email that is never coming — the exact lockout this ticket exists to end.
          // `LOBBY_REENTRY_TRANSPORT_ERROR` is a DEDICATED constant, never
          // `JOIN_UNAVAILABLE_TITLE` — see that constant's own docblock for the ruling.
          setState('unavailable');
          setErrorMessage(LOBBY_REENTRY_TRANSPORT_ERROR);
          toast.error(LOBBY_REENTRY_TRANSPORT_ERROR);
        });
    },
    [email, meetingId, state]
  );

  // ⚠ F4 — SUCCESS IS DELIBERATELY NOT A ONE-WAY DOOR. Without this, `handleToggle` only flips
  // `isExpanded` and `state` never resets, so collapsing/re-expanding shows the success message
  // forever, and the only recovery is an undiscoverable full page reload — stranding the exact
  // persona the neutral copy exists to serve: the guest who mistyped their address.
  const handleRetry = useCallback(() => {
    setState('idle');
    setErrorMessage(null);
  }, []);

  // ⚠ F15 — move focus to the success status text once it renders, so a keyboard/screen-reader
  // user is not left on `<body>` after the submit button unmounts.
  useEffect(() => {
    if (state === 'success') {
      successStatusRef.current?.focus();
    }
  }, [state]);

  const isSubmitting = state === 'submitting';
  const hasInlineError = state === 'invalid_input' || state === 'unavailable';

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={isExpanded}
        aria-controls={panelId}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {LOBBY_REENTRY_TRIGGER_LABEL}
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            id={panelId}
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.18 }}
            className="overflow-hidden"
          >
            <div className="border-border bg-muted/20 mt-3 rounded-xl border p-4">
              {state === 'success' ? (
                <div className="space-y-3">
                  <output
                    ref={successStatusRef}
                    tabIndex={-1}
                    className="text-foreground block text-[12.5px] leading-relaxed focus-visible:outline-none"
                  >
                    {LOBBY_REENTRY_NEUTRAL_MESSAGE}
                  </output>
                  <p className="text-muted-foreground text-[12px] leading-relaxed">
                    Didn&apos;t get anything after a few minutes? Double-check the spelling and try
                    again.
                  </p>
                  <button
                    type="button"
                    onClick={handleRetry}
                    className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -ml-1 min-h-11 rounded-lg px-1 text-[12.5px] font-medium underline-offset-2 transition-colors hover:underline focus-visible:ring-2 focus-visible:outline-none"
                  >
                    Try a different address
                  </button>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-3" noValidate>
                  <p className="text-muted-foreground text-[12.5px] leading-relaxed">
                    {LOBBY_REENTRY_HELPER}
                  </p>
                  <div className="space-y-1.5">
                    <label
                      htmlFor="lobby-reentry-email"
                      className="text-foreground block text-[12.5px] font-medium"
                    >
                      {LOBBY_REENTRY_EMAIL_LABEL}
                    </label>
                    <input
                      id="lobby-reentry-email"
                      name="email"
                      type="email"
                      required
                      maxLength={254}
                      autoComplete="email"
                      value={email}
                      aria-invalid={hasInlineError}
                      aria-describedby={hasInlineError ? errorId : undefined}
                      onChange={(event) => setEmail(event.target.value)}
                      className="border-border bg-background text-foreground focus-visible:ring-ring aria-[invalid=true]:border-destructive min-h-11 w-full rounded-lg border px-3 text-base focus-visible:ring-2 focus-visible:outline-none sm:text-[13.5px]"
                    />
                  </div>

                  {hasInlineError && errorMessage !== null && (
                    <p
                      id={errorId}
                      role="alert"
                      className="text-destructive text-[12px] leading-relaxed"
                    >
                      {errorMessage}
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    /* ⚠ `disabled:opacity-80`, NOT 60 — the primary submit's own rule: on
                       `bg-secondary` a deeper wash drops the label under 4.5:1. ⚠ SECONDARY
                       STYLING so it never competes with the primary "Ask to join". */
                    className="bg-secondary text-secondary-foreground focus-visible:ring-ring inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-4 text-base font-medium transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-80 sm:text-[13.5px]"
                  >
                    {isSubmitting ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : null}
                    {isSubmitting ? LOBBY_REENTRY_SUBMITTING_LABEL : LOBBY_REENTRY_SUBMIT_LABEL}
                  </button>
                </form>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
