'use client';

import { Link2Off, RefreshCw, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  JOIN_LONG_WAIT_BODY,
  JOIN_TEMPORARILY_UNAVAILABLE_BODY,
  JOIN_TEMPORARILY_UNAVAILABLE_TITLE,
  JOIN_UNAVAILABLE_BODY,
  JOIN_UNAVAILABLE_TITLE,
  JOIN_WAITING_BODY,
  JOIN_WAITING_TITLE,
} from '@/lib/meetings/lobby';

/**
 * BAL-132 — THE ONE NOTICE CARD BOTH JOIN SURFACES END ON.
 *
 * ⚠⚠ IT EXISTS SO THE TWO SURFACES CANNOT DIVERGE. `/join/m/[meetingId]` (the anonymous lobby)
 * and `/join/[token]` (the invited guest) each enforce the same no-oracle property, and each
 * used to render its own bail-out: the lobby a full card, `JoinControl` a bare `<p>` with no
 * icon, no body copy and no live region. Two implementations of one property is how the
 * property becomes per-surface, which is exactly what happened to the COPY before it was
 * hoisted into shared constants.
 *
 * ⚠ IT IS A LIVE REGION (`<output>`), NOT A STATIC BLOCK, because on both surfaces it appears
 * as the RESULT OF AN ACTION the visitor took — a submitted form, a pressed Join button. A
 * screen-reader user who presses Join and hears nothing has been told the click did nothing.
 *
 * ⚠⚠ AND IT CARRIES **NO** `aria-busy`. That attribute SUPPRESSES the announcements a live
 * region exists to make; on a persistent (non-loading) state it is not merely useless, it
 * silences the one message the element is there to deliver.
 */

interface JoinNoticeCardProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly body: string;
  /**
   * ⚠ FOCUS TARGET. Every state transition on these surfaces replaces the whole card, which
   * drops focus to `<body>` — a screen-reader or keyboard user is silently returned to the top
   * of the document with no idea anything happened. The owning component focuses this heading
   * on entry; `tabIndex={-1}` is what makes a non-interactive element focusable programmatically
   * without adding it to the tab order.
   */
  readonly headingRef?: React.Ref<HTMLHeadingElement>;
  /** An optional recovery affordance. ⚠ Never present on the collapsed-failure card. */
  readonly children?: React.ReactNode;
}

export function JoinNoticeCard({
  icon: Icon,
  title,
  body,
  headingRef,
  children,
}: Readonly<JoinNoticeCardProps>): React.JSX.Element {
  return (
    <output className="border-border bg-card mx-auto flex w-full max-w-md flex-col items-center rounded-2xl border p-8 text-center shadow-sm">
      <span className="border-border bg-muted/40 flex h-12 w-12 items-center justify-center rounded-2xl border">
        <Icon className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </span>
      <h1 ref={headingRef} tabIndex={-1} className="text-foreground mt-4 text-lg font-semibold">
        {title}
      </h1>
      <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">{body}</p>
      {children}
      <p className="text-muted-foreground border-border mt-6 w-full border-t pt-4 text-[11.5px]">
        Powered by <span className="text-foreground font-semibold">Balo</span>
      </p>
    </output>
  );
}

/**
 * ⚠⚠ THE ONE CARD FOR EVERY COLLAPSED FAILURE. **PROPLESS APART FROM ITS FOCUS REF, BY
 * DESIGN — THE TYPE SYSTEM IS THE ENFORCEMENT.**
 *
 * A cancelled meeting, an ended one, a full room, a full queue, a denied knock, a revoked
 * token and a meeting id that never existed all render THIS, byte for byte. A component that
 * accepted a `reason` would eventually be given one, and the page would be an oracle over
 * guessed uuids again. It accepts no `title`, no `body` and no `children` — there is nothing
 * to vary and no recovery to offer, because the only real recovery is a human one: ask the
 * person who shared the link.
 */
export function JoinUnavailableNotice({
  headingRef,
}: Readonly<{ headingRef?: React.Ref<HTMLHeadingElement> }>): React.JSX.Element {
  return (
    <JoinNoticeCard
      icon={Link2Off}
      title={JOIN_UNAVAILABLE_TITLE}
      body={JOIN_UNAVAILABLE_BODY}
      headingRef={headingRef}
    />
  );
}

/**
 * ⚠ THE **ONE** UN-COLLAPSED FAILURE, AND IT MAY HAVE A RETRY BECAUSE IT LEAKS NOTHING.
 *
 * Reachable only from a `503` on the guest poll — i.e. only after a ≥256-bit token has already
 * resolved AND the bearer was already ADMITTED. "Our own call-room provider did not answer"
 * tells that holder nothing they did not already know about a meeting that is demonstrably
 * theirs, and showing them the dead-link card instead is a lie that costs them the call.
 *
 * ⚠⚠ DO NOT ADD A SECOND VARIANT OF THIS FOR `429`. That one fires PRE-authorization; a
 * distinct message there tells an anonymous scanner they are being counted.
 */
export function JoinRetryNotice({
  onRetry,
  headingRef,
}: Readonly<{
  onRetry?: () => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}>): React.JSX.Element {
  return (
    <JoinNoticeCard
      icon={RefreshCw}
      title={JOIN_TEMPORARILY_UNAVAILABLE_TITLE}
      body={JOIN_TEMPORARILY_UNAVAILABLE_BODY}
      headingRef={headingRef}
    >
      {onRetry === undefined ? null : (
        <button
          type="button"
          onClick={onRetry}
          className="border-border text-foreground hover:bg-muted/60 focus-visible:ring-ring mt-5 inline-flex min-h-11 items-center justify-center rounded-lg border px-4 text-base font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none sm:text-[13.5px]"
        >
          Try again
        </button>
      )}
    </JoinNoticeCard>
  );
}

/**
 * ⚠⚠ THE **WAITING** CARD, SHARED BY BOTH SURFACES — the other half of the job F6 started.
 *
 * F6 hoisted the FAILURE copy into shared constants because `/join/m/[meetingId]` and
 * `/join/[token]` had already drifted ("Invitation links…" vs "Meeting links…") while a
 * docblock claimed they could not. It stopped at the failure copy — so `LobbyWaiting` and
 * `JoinWaiting` went on duplicating the `<output>` wrapper, the `Users` icon, the `<h1>`, the
 * closing rule and **two byte-identical copy literals**, i.e. the drift risk was eliminated in
 * one place and left live in the other. This is that fix, applied to the same surface area.
 *
 * ⚠ THE TWO SURFACES GENUINELY DIFFER IN TWO THINGS, AND ONLY TWO — so both are props rather
 * than a second component:
 *   · the LOBBY offers "Leave the queue" once the wait is long (its handle is a
 *     `sessionStorage` token, so there IS something local to drop);
 *   · the INVITED guest shows their scheduled window instead (their handle is the emailed
 *     URL, which they still have — a "leave" button that only returned them to a page they
 *     can reload would be theatre).
 * Anything a third caller needs should become a prop here, never a third copy of the markup.
 *
 * ⚠ NO `aria-busy`. It SUPPRESSES the announcements this live region exists to make, and this
 * is a persistent state rather than a loading one.
 */
export function JoinWaitingCard({
  headingRef,
  isLongWait,
  scheduledLine,
  children,
}: Readonly<{
  headingRef?: React.Ref<HTMLHeadingElement>;
  /** After {@link LOBBY_LONG_WAIT_AFTER_MS}. ⚠ A fact about the WAIT, never about the meeting. */
  isLongWait: boolean;
  /** The invited guest's viewer-local window. Absent on the anonymous lobby, which knows none. */
  scheduledLine?: React.ReactNode;
  /** The lobby's exit affordance. ⚠ Rendered only while `isLongWait`. */
  children?: React.ReactNode;
}>): React.JSX.Element {
  return (
    <output className="border-border bg-card mx-auto flex w-full max-w-md flex-col items-center rounded-2xl border p-8 text-center shadow-sm">
      <span className="border-border bg-muted/40 flex h-12 w-12 items-center justify-center rounded-2xl border">
        <Users className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </span>
      <h1 ref={headingRef} tabIndex={-1} className="text-foreground mt-4 text-lg font-semibold">
        {JOIN_WAITING_TITLE}
      </h1>
      <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">{JOIN_WAITING_BODY}</p>
      {scheduledLine}

      {/*
        ⚠ THE LONG-WAIT ACKNOWLEDGEMENT (F10). A wait with no acknowledgement reads as a hung
        page after a couple of minutes. ⚠ NEITHER THE LINE NOR ANYTHING IN `children` DISCLOSES
        ANYTHING about the meeting — both are facts about the visitor's own wait, so Decision 9
        is untouched.
      */}
      {isLongWait && (
        <>
          <p className="text-muted-foreground mt-3 text-[12.5px] leading-relaxed">
            {JOIN_LONG_WAIT_BODY}
          </p>
          {children}
        </>
      )}

      <p className="text-muted-foreground border-border mt-6 w-full border-t pt-4 text-[11.5px]">
        Powered by <span className="text-foreground font-semibold">Balo</span>
      </p>
    </output>
  );
}
