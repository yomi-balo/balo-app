'use client';

import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface JoinMeetingButtonProps {
  /** The TOKENLESS lobby URL (`/join/m/{meetingId}`) — navigated to, never rendered. */
  readonly joinUrl: string;
  /** Names the meeting, e.g. `Join Northwind's meeting, starting in 5 minutes`. */
  readonly ariaLabel: string;
  /** Analytics side effect, fired BEFORE the navigation is requested. */
  readonly onJoin: () => void;
  readonly size?: React.ComponentProps<typeof Button>['size'];
  readonly className?: string;
  readonly children: React.ReactNode;
}

/**
 * BAL-498 fix round 3 (S1 + A1) — the ONE Join affordance for both calendar surfaces.
 *
 * ⚠⚠ IT IS A `<button>`, AND THAT IS THE WHOLE POINT — DO NOT "RESTORE" THE `<a href>`.
 * This ticket was the first to render `meetingJoinLinkUrl`'s output into the DOM, and an
 * attribute is not a URL: PostHog autocapture is ON (`analytics/client/client.ts` passes no
 * `autocapture: false`) and ships `$elements[].attr__href`, while `sanitizeAnalyticsEvent` walks
 * only `$current_url`/`$pathname`/`$referrer`; Sentry `replayIntegration` records rrweb DOM
 * snapshots and its `maskAttributes` default does not include `href`. So an `href` here shipped
 * `/join/m/{meetingId}` — declared sensitive-by-policy in `SENSITIVE_PATH_PREFIXES` — to two
 * external processors un-redacted, on a page the expert merely LOOKS at. Keeping the URL out of
 * the DOM closes both channels at once, with no redaction hook to keep in sync.
 *
 * ⚠ `globalThis.location.assign` — a HARD DOCUMENT NAVIGATION, never `next/link` and never
 * `router.push`. D4 and the init-time Replay refusal at `instrumentation-client.ts:52` both
 * depend on a real navigation so `onSensitiveLanding` re-evaluates on the lobby landing; a soft
 * navigation would start Replay on the calendar and carry it INTO the token-adjacent route.
 *
 * ⚠ ≥44px HIT AREA (balo-ui NEVER-rule) via a transparent `after:` pseudo-element, so the visual
 * chip can stay small while the tap target is not. `min-h-11` where the button is in normal flow.
 *
 * ⚠ THE LIVE CUE IS UNCONDITIONAL (BAL-511 / ADR-1053 `ambient  live-call ping ring 1.8s`). It is
 * baked into this component rather than applied per call site because `JoinMeetingButton` is
 * rendered ONLY inside the join window at all three of today's call sites (`meeting-block.tsx`
 * full mode: `joinVisible && !compact`; its compact popover: `joinVisible &&`; `agenda-list.tsx`:
 * `joinVisible ? … : <ChevronRight/>`). If a future caller ever renders this component OUTSIDE
 * that gate, add a prop and condition the cue on it rather than deleting it — Join showing no
 * live affordance while genuinely joinable is the regression this paragraph exists to prevent.
 *
 * ⚠ BAL-513 EXTENDED THAT WINDOW to `scheduledEnd + MEETING_OVERRUN_GRACE_MINUTES` and moved
 * `isPast` onto the SAME boundary (`join-window.ts`'s `calendarMeetingTiming`), precisely so this
 * paragraph stays true: a meeting that ran over is still joinable, still ping-rings, and is NOT
 * muted. No `showLiveCue` prop was added, and none should be — if a future caller renders this
 * outside the gate, add the prop then rather than deleting the cue.
 */
export function JoinMeetingButton({
  joinUrl,
  ariaLabel,
  onJoin,
  size,
  className,
  children,
}: Readonly<JoinMeetingButtonProps>): React.JSX.Element {
  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      // The whole card behind this control is its own link target — Join must not also trigger it.
      event.stopPropagation();
      onJoin();
      globalThis.location.assign(joinUrl);
    },
    [joinUrl, onJoin]
  );

  return (
    <Button
      type="button"
      size={size}
      aria-label={ariaLabel}
      data-testid="calendar-join"
      onClick={handleClick}
      className={cn(
        // ⚠⚠ `relative` FIRST, AND IT MUST STAY BEFORE `className`. `cn` is tailwind-merge:
        // the LAST position utility wins, so the docked week chip's own `absolute` (meeting-
        // block.tsx) still overrides this — which is correct, an absolutely-positioned element
        // is already a containing block for its own pseudo-elements. At the other two sites
        // (agenda row, compact popover) neither `relative` nor `absolute` was present, so both
        // the existing `after:` hit area and the new `before:` ring were resolving against some
        // outer ancestor. This one word fixes both. Moving it AFTER `className` breaks the
        // docked chip's position entirely — a browser-only failure no gate catches (BAL-511 D6).
        'relative',
        // ⚠ `after:` IS RESERVED PLATFORM-WIDE by this component for the ≥44px hit area; call
        // sites supply only its SIZE (`after:-inset-2.5`, `after:-inset-3`), pinned by
        // meeting-block.test.tsx:197-198 and :293-294. Never "free it up" (BAL-511 D6 / O1).
        "after:absolute after:content-['']",
        // ADR-1053 `ambient  live-call ping ring 1.8s`, replacing a whole-button
        // `motion-safe:animate-pulse`. Every utility carries the `motion-safe:` prefix — INCLUDING
        // `content` — so under `prefers-reduced-motion` the pseudo-element is not generated at
        // all and only the static ring below remains ("accessibility — everything off under
        // prefers-reduced-motion").
        // ⚠ COLOUR: this button is the DEFAULT `Button` variant (`bg-primary
        // text-primary-foreground`), so a ring layered ON it reads as nothing. `-inset-1` starts
        // the ring 4px OUTSIDE the silhouette and `scale(2)` only ever moves it further out, so
        // it is always read against the page — `bg-card` in the week grid, `bg-popover` in the
        // compact popover, `bg-background` in Agenda. `ring-primary` is legible on all three in
        // both themes and keeps the same token family as the reduced-motion fallback (BAL-511 D8).
        // ⚠ `pointer-events-none`: without it the 2x-scaled ring would swallow clicks meant for
        // the card behind it and silently widen the tap target past the intended 44px.
        // ⚠ `rounded-[inherit]`: the chip is `rounded-full`, the other two are `rounded-md`.
        'motion-safe:before:pointer-events-none motion-safe:before:absolute motion-safe:before:-inset-1',
        "motion-safe:before:ring-primary motion-safe:before:rounded-[inherit] motion-safe:before:ring-2 motion-safe:before:content-['']",
        'motion-safe:before:animate-ping-slow',
        // The static "this is live" affordance under reduced motion. Moved here from two of the
        // three call sites so the third (the compact popover) gains it too — it had neither the
        // pulse nor this fallback (BAL-511 D2 / O2).
        // ⚠ FULL OPACITY, NOT `/40`. The ticket said to keep the pre-existing
        // `ring-primary/40`, but measured against all three backdrops that alpha is 1.47:1 in
        // light and 2.68:1 in dark — both below WCAG 1.4.11's 3:1 floor for a UI-component
        // boundary, and near-invisible in light mode. Since D2 propagates this fallback to a
        // NET-NEW third site, shipping `/40` would spread a failing value rather than merely
        // inherit it. Full opacity measures 5.05:1 light / 5.21-5.44:1 dark and keeps token
        // parity with the animated ring above (BAL-511 UX phase; supersedes the ticket text).
        'motion-reduce:ring-primary motion-reduce:ring-2',
        className
      )}
    >
      {children}
    </Button>
  );
}
