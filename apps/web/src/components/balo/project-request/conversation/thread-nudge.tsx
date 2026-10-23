'use client';

import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import type {
  ThreadNudgeButton,
  ThreadNudgeContent,
} from '@/lib/project-request/thread-nudge-content';

interface ThreadNudgeProps {
  nudge: ThreadNudgeContent;
  callPending: boolean;
  onReply: () => void;
  onCall: () => void;
  /**
   * Handler for the `build` action (expert "Build proposal" — opens the
   * composer, BAL-288 / A6.2). Undefined (client lens) → no button renders.
   */
  onBuild?: () => void;
  /** Handler for the `view` action — opens the proposal surface. */
  onView?: () => void;
  /**
   * Handler for the `accept` action (client "Accept {name}'s proposal" — opens the
   * review with the accept confirmation up). Undefined → no button renders.
   */
  onAccept?: () => void;
}

/**
 * Compact per-thread nudge card — "the live edge at the top of the thread".
 * Visually mirrors `NudgeBar`'s rail/eyebrow/variant styling (semantic tokens
 * only) but is its OWN client component: `NudgeBar` is a server component
 * hard-wired to `NudgeActions`' WIRED map, while this nudge's CTAs are thread-
 * scoped (`reply` focuses the composer, `call` hits the mock seam, `build`
 * opens the proposal composer, `view`/`accept` open the proposal surface,
 * `link` navigates). An action whose handler is absent renders no button; the `event` variant
 * is a one-line timeline marker with no card.
 */

type CardVariant = Exclude<ThreadNudgeContent['variant'], 'event'>;

const EYEBROW: Record<CardVariant, string> = {
  action: 'Your next step',
  commit: 'Your next step',
  waiting: 'Waiting',
  done: 'Done',
};

function accentClasses(variant: CardVariant): {
  rail: string;
  iconWrap: string;
  icon: string;
  eyebrow: string;
} {
  if (variant === 'waiting') {
    return {
      rail: 'bg-warning',
      iconWrap: 'bg-warning/10 border-warning/30',
      icon: 'text-warning',
      eyebrow: 'text-warning',
    };
  }
  if (variant === 'done') {
    return {
      rail: 'bg-success',
      iconWrap: 'bg-success/10 border-success/30',
      icon: 'text-success',
      eyebrow: 'text-success',
    };
  }
  return {
    rail: 'bg-primary',
    iconWrap: 'bg-primary/10 border-primary/30',
    icon: 'text-primary',
    eyebrow: 'text-primary',
  };
}

const PRIMARY_CLASS =
  'bg-primary text-primary-foreground focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-[10px] px-3.5 text-[13px] font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none lg:min-h-9';
const SECONDARY_CLASS =
  'border-border bg-card text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-[10px] border px-3 text-[12.5px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none lg:min-h-9';
/**
 * BAL-283 — the "Share again" re-share affordance: a TEXT LINK, deliberately harder to reach
 * than the first share (never button chrome). `min-h-11` still pads the tap target per the
 * balo-ui-skill 44px rule, even though the visible underline stays small.
 */
const TERTIARY_CLASS =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center gap-1 text-[12.5px] font-medium underline decoration-dotted underline-offset-2 transition-colors focus-visible:ring-2 focus-visible:outline-none lg:min-h-9';

export function ThreadNudge({
  nudge,
  callPending,
  onReply,
  onCall,
  onBuild,
  onView,
  onAccept,
}: Readonly<ThreadNudgeProps>): React.JSX.Element {
  const Icon = nudge.icon;

  if (nudge.variant === 'event') {
    return (
      <output data-nudge="event" className="flex items-center gap-2.5 p-0.5">
        <span aria-hidden="true" className="bg-border h-px flex-1" />
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[12.5px]">
          <Icon className="text-success size-3.5" aria-hidden="true" />
          {nudge.headline}
        </span>
        <span aria-hidden="true" className="bg-border h-px flex-1" />
      </output>
    );
  }

  const a = accentClasses(nudge.variant);

  const handlerFor = (
    button: Exclude<ThreadNudgeButton, { action: 'link' }>
  ): (() => void) | undefined => {
    switch (button.action) {
      case 'reply':
        return onReply;
      case 'call':
        return onCall;
      case 'build':
        return onBuild;
      case 'view':
        return onView;
      case 'accept':
        return onAccept;
    }
  };

  const renderButton = (button: ThreadNudgeButton, className: string): React.JSX.Element | null => {
    const ButtonIcon = button.icon;
    if (button.action === 'link') {
      return (
        <Link href={button.href} className={className}>
          <ButtonIcon className="h-3.5 w-3.5" aria-hidden="true" />
          {button.label}
        </Link>
      );
    }
    const handler = handlerFor(button);
    if (handler === undefined) return null;
    const pending = button.action === 'call' && callPending;
    return (
      <button
        type="button"
        onClick={handler}
        disabled={pending}
        className={cn(className, pending && 'opacity-60')}
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <ButtonIcon className="h-3.5 w-3.5" aria-hidden="true" />
        )}
        {button.label}
      </button>
    );
  };

  const primary = nudge.primary ? renderButton(nudge.primary, PRIMARY_CLASS) : null;
  const secondary = nudge.secondary ? renderButton(nudge.secondary, SECONDARY_CLASS) : null;
  const tertiary = nudge.tertiary ? renderButton(nudge.tertiary, TERTIARY_CLASS) : null;

  return (
    <div className="border-border bg-card flex items-stretch overflow-hidden rounded-xl border">
      <span className={cn('w-1 shrink-0', a.rail)} aria-hidden="true" />
      <div className="min-w-0 flex-1 p-3.5">
        <div className="mb-0.5 flex items-center gap-2">
          <span
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
              a.iconWrap
            )}
          >
            <Icon className={cn('h-3 w-3', a.icon)} aria-hidden="true" />
          </span>
          <span className={cn('text-[10px] font-bold tracking-wider uppercase', a.eyebrow)}>
            {EYEBROW[nudge.variant]}
          </span>
        </div>
        <p className="text-foreground ml-7 text-sm font-semibold">{nudge.headline}</p>
        {nudge.sub && (
          <p className="text-muted-foreground mt-0.5 ml-7 line-clamp-2 text-[13px] leading-relaxed">
            {nudge.sub}
          </p>
        )}
        {/* BAL-283 (round-1 W4) — an ABSOLUTE instant, formatted by `LocalDateTime` in the
            VIEWER's zone AFTER mount. Formatting it in `threadNudgeFor` (a pure deriver that
            runs during the SSR pass of this `'use client'` island) produced server/client HTML
            that differed for every viewer outside UTC — a hydration mismatch on every page
            load, invisible to a `TZ=UTC` CI. */}
        {nudge.subInstant && (
          <p className="text-muted-foreground mt-0.5 ml-7 line-clamp-2 text-[13px] leading-relaxed">
            <LocalDateTime iso={nudge.subInstant.iso} variant="day-month-time" />
            {nudge.subInstant.suffix}
          </p>
        )}
        {(primary || secondary || tertiary) && (
          <div className="mt-2.5 ml-7 flex flex-wrap items-center gap-2">
            {primary}
            {secondary}
            {tertiary}
          </div>
        )}
      </div>
    </div>
  );
}
