'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Loader2, LogIn } from 'lucide-react';
import { toast } from 'sonner';
import { MeetingCallSurface } from '@/components/balo/meetings/meeting-call-surface';
import {
  JoinRetryNotice,
  JoinUnavailableNotice,
  JoinWaitingCard,
} from '@/components/balo/meetings/join-notice-card';
import {
  GUEST_READ_UNAVAILABLE_ERROR,
  JOIN_UNAVAILABLE_TITLE,
  LOBBY_LONG_WAIT_AFTER_MS,
  LOBBY_TOKEN_STORAGE_KEY,
  LOBBY_WAIT_STARTED_STORAGE_KEY,
} from '@/lib/meetings/lobby';
import { useFocusOnTransition } from '@/lib/meetings/use-focus-on-transition';
import { useAdmissionPoll } from '@/lib/meetings/use-admission-poll';
import { MeetingRouteContextProvider } from '@/lib/meetings/meeting-route-context';
import type { MeetingGuestPanelRegistration } from '@/lib/meetings/meeting-panels';
// ⚠ C5 — RELATIVE IMPORTS, one level deeper than `join-control.tsx`'s (`_actions` sits at
// `app/join/_actions`, this route is `app/join/m/[meetingId]`).
import { claimLobbyPlaceAction } from '../../_actions/claim-lobby-place';
import { listGuestMeetingFilesAction } from '../../_actions/list-guest-meeting-files';
import { getGuestMeetingFileDownloadAction } from '../../_actions/get-guest-meeting-file-download';
import type { JoinGrant } from '@/lib/meetings/join-api-client';

/**
 * BAL-132 — the lobby's FIVE-STATE MACHINE.
 *
 *   identify    → the name + email form. Submitting claims a place in the queue.
 *   waiting     → "waiting for someone to let you in", polling until a host decides.
 *   admitted    → hand the grant to `MeetingCallSurface`. Terminal.
 *   unavailable → the ONE card every collapsed failure renders. Terminal.
 *   retry_later → the ONE un-collapsed failure (a `503` mint outage). Terminal, but recoverable.
 *
 * ⚠⚠ `unavailable` IS ONE STATE FOR EVERY COLLAPSED FAILURE, AND THE COPY IS A SHARED
 * CONSTANT. A cancelled meeting, an ended one, a full room, a full queue, a denied knock, a
 * revoked token and a meeting id that never existed all land here with BYTE-IDENTICAL markup —
 * rendered by the propless `JoinUnavailableNotice`, which `/join/[token]` also uses, so the two
 * surfaces cannot drift. Splitting any of them out turns this page into an oracle over guessed
 * uuids. `lobby-client.test.tsx` pins it across genuinely DIFFERENT upstream shapes.
 *
 * ⚠ `retry_later` IS THE ONE EXCEPTION AND IT IS NARROW: only a `503`, which is reachable only
 * after a ≥256-bit token resolved AND the bearer was already admitted. See
 * `poll-guest-admission.ts`. ⚠ A `429` is NOT split out — it fires pre-authorization.
 *
 * ── ⚠⚠ FAILURE IS NOT THE SAME THING AS REFUSAL ─────────────────────────────────────────
 *
 * The first cut treated EVERY poll failure as terminal, and the api client collapsed transport
 * errors, `429`s and `503`s into one indistinguishable shape. So a dropped packet ended the
 * wait and showed a live guest a dead-link card — and because setting a terminal state stops
 * the scheduler, the entire 5s→15s back-off (whose only purpose is to keep a guest inside the
 * rate limit across a ~35-minute wait) could never run past the first blip. On the
 * patchy-signal phone that IS this surface's primary context, that is the common case.
 *
 * Now: `status` is threaded through, retryable failures (transport, `429`, `>= 500`) KEEP
 * POLLING under a bounded consecutive-failure counter, a `429`'s `Retry-After` is honoured, and
 * only `404` / `409` are terminal.
 *
 * ⚠ THE LOBBY TOKEN IS MIRRORED TO `sessionStorage`, NEVER `localStorage`, so a reload resumes
 * the poll but the credential dies with the tab — the same reasoning that stops `/join/[token]`
 * minting a cookie. Read via `globalThis.sessionStorage` (S7764). ⚠ AND IT IS CLEARED ON EVERY
 * TERMINAL TRANSITION (see `fail`): leaving it behind meant a reload resurrected a false
 * "waiting" state that lied for one poll interval and then flipped back — worst for the denied
 * guest, who is the person most likely to refresh.
 *
 * ⚠ TOAST ON THE SUBMIT, NEVER ON A POLL TICK. CLAUDE.md wants a toast on every user-INITIATED
 * mutation; a background poll is not one, and at one every five seconds it would be unusable.
 *
 * ⚠ NO `@balo/db` VALUE IMPORT ANYWHERE IN THIS FILE. A `'use client'` module that
 * value-imports it drags `postgres` into the browser graph and kills `next build` with "can't
 * resolve 'tls'" — a failure NO local gate catches. `join-link-never-writes.test.ts` pins it.
 */

type LobbyState = 'identify' | 'waiting' | 'admitted' | 'unavailable' | 'retry_later';

interface LobbyClientProps {
  readonly meetingId: string;
}

/** ⚠ Storage can THROW on access in a locked-down profile, not merely return null. */
function readStorage(key: string): string | null {
  try {
    return globalThis.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.sessionStorage.setItem(key, value);
  } catch {
    // Storage unavailable — the poll still works, it just will not survive a reload.
  }
}

function clearStorage(key: string): void {
  try {
    globalThis.sessionStorage.removeItem(key);
  } catch {
    // Nothing to clean up, or nothing we are allowed to clean up.
  }
}

export function LobbyClient({ meetingId }: Readonly<LobbyClientProps>): React.JSX.Element {
  const [state, setState] = useState<LobbyState>('identify');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [grant, setGrant] = useState<JoinGrant | null>(null);
  /** Drives the long-wait acknowledgement. ⚠ A fact about the WAIT, never about the meeting. */
  const [isLongWait, setIsLongWait] = useState(false);

  const reduceMotion = useReducedMotion();

  /**
   * The raw lobby token, mirrored to sessionStorage so a reload resumes.
   *
   * ⚠ IN **STATE**, NOT A REF — it is what enables the poll, and `useAdmissionPoll` keys its
   * scheduler on it, so a ref would leave the hook unaware that a token had arrived.
   */
  const [lobbyToken, setLobbyToken] = useState<string | null>(null);
  /**
   * When waiting began — drives the back-off AND the long-wait line, and is MIRRORED to storage
   * (F26) so neither resets on a reload.
   */
  const [waitingSince, setWaitingSince] = useState<number | null>(null);

  /**
   * ⚠⚠ FOCUS FOLLOWS THE STATE — AND IT IS A **CALLBACK REF**, NOT A REF READ IN AN EFFECT.
   * The card below sits inside `<AnimatePresence mode="wait">`, which does not mount the
   * incoming child until the outgoing one has finished exiting, so an effect that reads
   * `ref.current` on a state change focuses the element that is about to unmount and focus
   * falls to `<body>`. See `useFocusOnTransition` for the full argument and the test that
   * reproduces the real ordering. Each state's `h1` carries `tabIndex={-1}`.
   */
  const headingRef = useFocusOnTransition(state);

  const tokenKey = `${LOBBY_TOKEN_STORAGE_KEY}:${meetingId}`;
  const waitStartKey = `${LOBBY_WAIT_STARTED_STORAGE_KEY}:${meetingId}`;

  /**
   * ⚠⚠ THE SINGLE TERMINAL EXIT, AND IT **CLEARS THE STORED TOKEN FIRST**.
   *
   * Without this the credential outlived the state that abandoned it, so a reload re-entered
   * `waiting` from a token already known to be dead: the page then claimed "waiting for someone
   * to let you in" for a full poll interval before flipping back to the failure card. The
   * person most likely to hit that is the one who was just DENIED, i.e. the one for whom the
   * false hope is least kind.
   */
  const fail = useCallback(
    (next: 'unavailable' | 'retry_later'): void => {
      clearStorage(tokenKey);
      clearStorage(waitStartKey);
      setLobbyToken(null);
      setWaitingSince(null);
      setState(next);
    },
    [tokenKey, waitStartKey]
  );

  const handleAdmitted = useCallback(
    (admittedGrant: JoinGrant): void => {
      setGrant(admittedGrant);
      // ⚠ THE CREDENTIAL IS SPENT — drop the queue handle so a later reload cannot re-enter a
      // wait that already ended.
      clearStorage(tokenKey);
      clearStorage(waitStartKey);
      setState('admitted');
    },
    [tokenKey, waitStartKey]
  );

  /**
   * ⚠⚠ THE POLL POLICY LIVES IN `useAdmissionPoll`, SHARED WITH `/join/[token]`. Cadence,
   * back-off, which failures retry, how many consecutive failures are tolerated and whether
   * `Retry-After` is honoured are five decisions that must AGREE between the two surfaces; a
   * second copy here is how they stop agreeing.
   */
  useAdmissionPoll({
    meetingId,
    // ⚠ Only while waiting: an admitted or failed state must not keep hitting the endpoint.
    guestToken: state === 'waiting' ? lobbyToken : null,
    waitingSince,
    onAdmitted: handleAdmitted,
    onExhausted: fail,
  });

  /**
   * Resume an in-flight wait after a reload.
   *
   * ⚠ `globalThis.sessionStorage`, guarded — SonarCloud S7764 prefers `globalThis` over a bare
   * `window`, and the guard keeps this safe if it ever runs where storage is absent (a
   * locked-down browser profile throws on access, not just on read).
   *
   * ⚠⚠ THE WAIT'S START INSTANT IS RESTORED TOO (F26). Without it the back-off reset on every
   * reload, so a guest who refreshed a few times over a long wait silently reverted to the fast
   * 5s cadence — spending exactly the budget the back-off exists to protect.
   */
  useEffect(() => {
    // ⚠ `globalThis.window === undefined`, NOT `typeof … === 'undefined'` (SonarJS
    // `no-typeof-undefined`). The `typeof` guard is only necessary for a BARE identifier, which
    // would throw a ReferenceError when undeclared; `globalThis.window` is a property access
    // and is safe to compare directly. CLAUDE.md's S7764 rule is about preferring
    // `globalThis.*` over bare `window.*` — which this still does.
    if (globalThis.window === undefined) return;
    const stored = readStorage(tokenKey);
    if (stored === null || stored.length === 0) return;

    const storedStart = Number.parseInt(readStorage(waitStartKey) ?? '', 10);
    const now = Date.now();
    // ⚠ A future or absurd stored value falls back to "now" rather than producing a negative
    // elapsed time (a tampered store, or a clock that moved).
    setWaitingSince(
      Number.isFinite(storedStart) && storedStart > 0 && storedStart <= now ? storedStart : now
    );
    setLobbyToken(stored);
    setState('waiting');
  }, [tokenKey, waitStartKey]);

  /**
   * ⚠ THE LONG-WAIT ACKNOWLEDGEMENT (F10). A separate, slow timer rather than a value derived
   * from the poll ticks: tying copy to those would make the message appear at a different moment
   * depending on network luck.
   */
  useEffect(() => {
    if (state !== 'waiting') {
      setIsLongWait(false);
      return;
    }
    const startedAt = waitingSince ?? Date.now();
    const remaining = LOBBY_LONG_WAIT_AFTER_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      setIsLongWait(true);
      return;
    }
    const timer = setTimeout(() => setIsLongWait(true), remaining);
    return () => clearTimeout(timer);
  }, [state, waitingSince]);

  /**
   * ⚠⚠ LEAVE THE QUEUE (F10). Discloses NOTHING — it neither asks the server anything nor
   * reports anything, it just drops this browser's own handle and returns to the form. So
   * Decision 9's no-oracle rule is untouched.
   *
   * ⚠ IT DOES **NOT** WITHDRAW THE ROW SERVER-SIDE. There is no such endpoint, and inventing an
   * unauthenticated delete on a public surface is its own ticket. The queue entry ages out; the
   * host can deny it. Documented rather than implied, because "leave" reads like it revokes.
   */
  const handleLeaveQueue = useCallback((): void => {
    clearStorage(tokenKey);
    clearStorage(waitStartKey);
    setLobbyToken(null);
    setWaitingSince(null);
    setFormError(null);
    setState('identify');
  }, [tokenKey, waitStartKey]);

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      if (isSubmitting) return;

      setIsSubmitting(true);
      setFormError(null);
      // ⚠ DELIBERATELY NOT AWAITED — a React event handler must stay synchronous, and every
      // outcome (including the transport arm) is handled in the chain below.
      //
      // ⚠ AND DELIBERATELY NOT PREFIXED WITH `void`. This repo does not enable type-aware
      // linting (`tseslint.configs.recommended`, not `recommendedTypeChecked`), so
      // `no-floating-promises` never fires and the operator bought nothing — while SonarCloud
      // S3735 flags it, and `error.tsx` + `meeting-call-surface.tsx` in this same slice
      // explicitly refuse `void` CITING THAT RULE. One position, applied everywhere: no `void`
      // operator on this surface, with the intent written out instead.
      claimLobbyPlaceAction({ meetingId, name, email })
        .then((result) => {
          if (!result.success) {
            // ⚠⚠ A VALIDATION FAILURE IS **NOT** TERMINAL, AND IT MUST NOT DESTROY THE TYPED
            // VALUES. It is reachable in ordinary use: the browser's own `required` accepts a
            // whitespace-only name and `type="email"` accepts `a@b`, both of which Zod rejects.
            // Treating that as "this link isn't active" threw away what the visitor typed and
            // stranded them on a dead-end card for a mistake they could have fixed in a second.
            if (result.kind === 'invalid_input') {
              setFormError(result.error);
              return;
            }
            // ⚠ TOAST HERE — this IS a user-initiated mutation.
            toast.error(result.error);
            fail('unavailable');
            return;
          }
          const startedAt = Date.now();
          writeStorage(tokenKey, result.lobbyToken);
          writeStorage(waitStartKey, String(startedAt));
          setWaitingSince(startedAt);
          setLobbyToken(result.lobbyToken);
          toast.success("You're in the queue");
          setState('waiting');
        })
        .catch(() => {
          // ⚠⚠ THE TRANSPORT ARM. Without it a dropped connection was COMPLETELY SILENT: the
          // spinner stopped and nothing else happened, on the patchy-signal phone that is this
          // surface's primary context. We stay in `identify` with the values intact, because
          // pressing the button again is the correct next move.
          toast.error(JOIN_UNAVAILABLE_TITLE);
        })
        .finally(() => {
          setIsSubmitting(false);
        });
    },
    [email, fail, isSubmitting, meetingId, name, tokenKey, waitStartKey]
  );

  const isReduced = reduceMotion === true;

  /**
   * BAL-445 §7 — the anonymous lobby visitor's READ-ONLY registration: FILES ONLY, `chat:
   * null`. `/join/m/[meetingId]/page.tsx` performs NO database read at all (a deliberate,
   * documented decision — see its own docblock), so there is no server-resolved primary
   * context to test `hasChat` against here the way `join-control.tsx` can. Opening Chat for
   * this mount is a follow-up that should carry that GET-path read decision with it.
   *
   * ⚠ MEMOISED ON `[meetingId, lobbyToken]` ALONE, matching `join-control.tsx`'s pattern.
   *
   * ⚠⚠ G2 (fix-round-3) — `lobbyToken` IS NARROWED HERE, NEVER LAUNDERED WITH `?? ''`. This
   * panel is only ever rendered once `state === 'admitted'`, by which point `lobbyToken` is
   * always set (either from the just-completed claim or restored from storage on resume) — but
   * the memo itself runs on every render regardless of `state`, so its callbacks must cope with
   * a `null` token honestly rather than coercing it into a value the Zod `min(20)` schema then
   * has to reject. A `null` check inside each callback makes the empty string UNREPRESENTABLE
   * on the wire, rather than merely rejected once it gets there.
   */
  const panels = useMemo<MeetingGuestPanelRegistration>(
    () => ({
      audience: 'guest',
      files: {
        list: () => {
          if (lobbyToken === null) {
            return Promise.resolve({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
          }
          return listGuestMeetingFilesAction({ meetingId, guestToken: lobbyToken });
        },
        download: (fileId) => {
          if (lobbyToken === null) {
            return Promise.resolve({ success: false, error: GUEST_READ_UNAVAILABLE_ERROR });
          }
          return getGuestMeetingFileDownloadAction({ meetingId, guestToken: lobbyToken, fileId });
        },
      },
      chat: null,
    }),
    [meetingId, lobbyToken]
  );

  let content: React.JSX.Element;
  if (state === 'admitted' && grant !== null) {
    content = (
      <MeetingRouteContextProvider
        meetingId={null}
        viewerName={null}
        title={null}
        backTo={null}
        contextNoun="call"
        waiting={null}
        panels={panels}
      >
        <MeetingCallSurface
          roomUrl={grant.roomUrl}
          token={grant.token}
          isOwner={grant.isOwner}
          // ⚠ ALWAYS `false` ON THIS ARM, HARD-CODED SERVER-SIDE exactly as `isOwner` is — see
          // `join-control.tsx`. PASSED THROUGH, never defaulted here.
          canEndMeeting={grant.canEndMeeting}
          expiresAt={grant.expiresAt}
          participantId={grant.participantId}
          // ⚠ THE TRANSITION THAT MATTERS MOST. Without this the one state the visitor actually
          // waited for — "you're in" — was the only one that moved focus nowhere.
          headingRef={headingRef}
        />
      </MeetingRouteContextProvider>
    );
  } else if (state === 'retry_later') {
    // ⚠ "Try again" returns to the FORM, not to a re-poll: the token was cleared by `fail`, so
    // there is nothing left to poll with. Re-identifying is the honest recovery.
    content = <JoinRetryNotice headingRef={headingRef} onRetry={handleLeaveQueue} />;
  } else if (state === 'unavailable') {
    content = <JoinUnavailableNotice headingRef={headingRef} />;
  } else if (state === 'waiting') {
    content = (
      <LobbyWaiting
        headingRef={headingRef}
        isLongWait={isLongWait}
        onLeave={handleLeaveQueue}
        reduceMotion={isReduced}
      />
    );
  } else {
    content = (
      <LobbyIdentify
        name={name}
        email={email}
        formError={formError}
        isSubmitting={isSubmitting}
        headingRef={headingRef}
        reduceMotion={isReduced}
        onNameChange={setName}
        onEmailChange={setEmail}
        onSubmit={handleSubmit}
      />
    );
  }

  /**
   * ⚠ RESTRAINED, AND DISABLED UNDER `prefers-reduced-motion`. A 4px lift and a fade over 180ms.
   * The states used to be hard cuts, which on a surface whose whole job is "wait, then something
   * changes" reads as a page reload rather than as progress.
   *
   * ⚠ `initial={false}` — no entrance animation on first paint. The visitor did not do anything
   * yet; animating at them would be decoration.
   */
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={state}
        initial={isReduced ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={isReduced ? undefined : { opacity: 0 }}
        transition={{ duration: isReduced ? 0 : 0.18 }}
      >
        {content}
      </motion.div>
    </AnimatePresence>
  );
}

/**
 * ⚠ SHARED INPUT CLASSES. `text-base sm:text-[13.5px]` IS NOT A STYLE PREFERENCE: iOS Safari
 * AUTO-ZOOMS the viewport on focusing any input whose computed font-size is under 16px, and it
 * does not zoom back out. A forwarded meeting link opened on a phone is THE primary context for
 * this surface, so a bare `text-[13.5px]` meant the first thing most visitors experienced was
 * the page lurching. 16px on small screens, the design system's density from `sm:` up.
 */
const INPUT_CLASSES =
  'border-border bg-background text-foreground focus-visible:ring-ring aria-[invalid=true]:border-destructive min-h-11 w-full rounded-lg border px-3 text-base focus-visible:ring-2 focus-visible:outline-none sm:text-[13.5px]';

interface LobbyIdentifyProps {
  readonly name: string;
  readonly email: string;
  readonly formError: string | null;
  readonly isSubmitting: boolean;
  readonly headingRef: React.Ref<HTMLHeadingElement>;
  readonly reduceMotion: boolean;
  readonly onNameChange: (value: string) => void;
  readonly onEmailChange: (value: string) => void;
  readonly onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
}

function LobbyIdentify({
  name,
  email,
  formError,
  isSubmitting,
  headingRef,
  reduceMotion,
  onNameChange,
  onEmailChange,
  onSubmit,
}: Readonly<LobbyIdentifyProps>): React.JSX.Element {
  const hasError = formError !== null;

  return (
    <div className="border-border bg-card mx-auto w-full max-w-md rounded-2xl border p-8 shadow-sm">
      <span className="border-border bg-muted/40 mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border">
        <LogIn className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </span>
      <h1
        ref={headingRef}
        tabIndex={-1}
        className="text-foreground mt-4 text-center text-lg font-semibold"
      >
        Join this meeting
      </h1>
      <p className="text-muted-foreground mt-2 text-center text-[13px] leading-relaxed">
        Tell us who you are, and we&apos;ll let the host know you&apos;re here.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <div className="space-y-1.5">
          {/* ⚠ `htmlFor` matched to the control's `id` — every label needs an association. */}
          <label htmlFor="lobby-name" className="text-foreground block text-[13px] font-medium">
            Your name{' '}
            {/* ⚠ A VISIBLE required marker, not just the `required` attribute — which is
                announced but never SEEN. `aria-hidden` because the input's own `required`
                already conveys it to assistive tech; a doubled "required required" is noise. */}
            <span className="text-destructive" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="lobby-name"
            name="name"
            type="text"
            required
            /* ⚠ THE FORM IS THE WHOLE PAGE — there is nothing else here to read first, and a
               visitor arrived by clicking a join link, so focusing the first field is what they
               came to do. */
            autoFocus
            maxLength={160}
            autoComplete="name"
            value={name}
            aria-invalid={hasError}
            aria-describedby={hasError ? 'lobby-form-error' : undefined}
            onChange={(event) => onNameChange(event.target.value)}
            className={INPUT_CLASSES}
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="lobby-email" className="text-foreground block text-[13px] font-medium">
            Your email{' '}
            <span className="text-destructive" aria-hidden="true">
              *
            </span>
          </label>
          <input
            id="lobby-email"
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            value={email}
            aria-invalid={hasError}
            /*
              ⚠⚠ IT SAYS WHY (F17). Asking a stranger for an email address with no explanation is
              the single most friction-generating moment on this surface — the reasonable
              assumption is marketing. The hint discloses a fact about BALO'S PROCESS, not about
              the meeting (no title, no company, no participants), so Decision 9 holds.
            */
            aria-describedby={hasError ? 'lobby-email-hint lobby-form-error' : 'lobby-email-hint'}
            onChange={(event) => onEmailChange(event.target.value)}
            className={INPUT_CLASSES}
          />
          <p id="lobby-email-hint" className="text-muted-foreground text-[11.5px] leading-relaxed">
            The host sees this when they decide whether to let you in. We don&apos;t use it for
            anything else.
          </p>
        </div>

        {/*
          ⚠ AN INLINE, ASSOCIATED ERROR — not a toast and not a state change. It is a fact about
          the visitor's OWN INPUT, it is fixable in place, and both controls point at it through
          `aria-describedby`, so a screen-reader user hears it when they land on the field.
        */}
        {hasError && (
          <p
            id="lobby-form-error"
            role="alert"
            className="text-destructive text-[12.5px] leading-relaxed"
          >
            {formError}
          </p>
        )}

        <motion.button
          type="submit"
          disabled={isSubmitting}
          whileTap={reduceMotion ? undefined : { scale: 0.985 }}
          /* ⚠ `disabled:opacity-80`, NOT 60. On `bg-primary` a 60% wash drops the label under
             4.5:1 — at the exact moment the visitor is most anxious about whether the click
             registered. 80 stays legible while still reading as inert. */
          className="bg-primary text-primary-foreground focus-visible:ring-ring inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg px-4 text-base font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-80 sm:text-[13.5px]"
        >
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {isSubmitting ? 'Asking to join…' : 'Ask to join'}
        </motion.button>
      </form>

      <p className="text-muted-foreground border-border mt-6 border-t pt-4 text-[11.5px]">
        Powered by <span className="text-foreground font-semibold">Balo</span>
      </p>
    </div>
  );
}

/**
 * The lobby's waiting state. ⚠ Says nothing about the meeting — it does not know anything
 * about it.
 *
 * ⚠⚠ THE CARD ITSELF IS `JoinWaitingCard`, SHARED WITH `/join/[token]`. This component supplies
 * only what is genuinely lobby-specific: the "Leave the queue" exit. The wrapper, the icon, the
 * heading and BOTH copy literals used to be duplicated here and in `join-control.tsx` — two
 * byte-identical copies of the same words in two files, which is precisely the drift the
 * failure copy was hoisted into shared constants to stop. Do not re-inline any of it.
 */
function LobbyWaiting({
  headingRef,
  isLongWait,
  onLeave,
  reduceMotion,
}: Readonly<{
  headingRef: React.Ref<HTMLHeadingElement>;
  isLongWait: boolean;
  onLeave: () => void;
  reduceMotion: boolean;
}>): React.JSX.Element {
  return (
    <JoinWaitingCard headingRef={headingRef} isLongWait={isLongWait}>
      {/*
        ⚠ THE ONLY WAY OUT (F10). A wait with no exit reads as a hung page after a couple of
        minutes, and the visitor's only recourse was closing the tab — which also destroys the
        token and their queue place, with no way back. ⚠ IT DISCLOSES NOTHING: it neither asks
        the server anything nor reports anything, so Decision 9 is untouched.
      */}
      <motion.button
        type="button"
        onClick={onLeave}
        whileTap={reduceMotion ? undefined : { scale: 0.985 }}
        className="border-border text-foreground hover:bg-muted/60 focus-visible:ring-ring mt-4 inline-flex min-h-11 items-center justify-center rounded-lg border px-4 text-base font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none sm:text-[13.5px]"
      >
        Leave the queue
      </motion.button>
    </JoinWaitingCard>
  );
}
