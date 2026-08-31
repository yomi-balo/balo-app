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
      className={cn("after:absolute after:content-['']", className)}
    >
      {children}
    </Button>
  );
}
