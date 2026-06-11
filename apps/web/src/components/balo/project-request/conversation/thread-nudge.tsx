'use client';

import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
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
   * composer, BAL-288 / A6.2). Undefined (client lens) → the button renders
   * disabled, as for `stub`.
   */
  onBuild?: () => void;
}

/**
 * Compact per-thread nudge card — "the live edge at the top of the thread".
 * Visually mirrors `NudgeBar`'s rail/eyebrow/variant styling (semantic tokens
 * only) but is its OWN client component: `NudgeBar` is a server component
 * hard-wired to `NudgeActions`' WIRED map, while this nudge's CTAs are thread-
 * scoped (`reply` focuses the composer, `call` hits the mock seam, `build`
 * opens the proposal composer, `stub` renders disabled for A5/A6.3).
 */

const EYEBROW: Record<ThreadNudgeContent['variant'], string> = {
  action: 'Your next step',
  commit: 'Your next step',
  waiting: 'Waiting',
  done: 'Done',
};

function accentClasses(variant: ThreadNudgeContent['variant']): {
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
  'from-primary focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-[10px] bg-gradient-to-r to-violet-600 px-3.5 text-[13px] font-semibold text-white transition-opacity focus-visible:ring-2 focus-visible:outline-none lg:min-h-9 dark:to-violet-500';
const SECONDARY_CLASS =
  'border-border bg-card text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-[10px] border px-3 text-[12.5px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none lg:min-h-9';

export function ThreadNudge({
  nudge,
  callPending,
  onReply,
  onCall,
  onBuild,
}: Readonly<ThreadNudgeProps>): React.JSX.Element {
  const a = accentClasses(nudge.variant);
  const Icon = nudge.icon;

  const handlerFor = (button: ThreadNudgeButton): (() => void) | undefined => {
    if (button.action === 'reply') return onReply;
    if (button.action === 'call') return onCall;
    if (button.action === 'build') return onBuild;
    return undefined; // stub — disabled, owned by A5/A6.3
  };

  const renderButton = (button: ThreadNudgeButton, className: string): React.JSX.Element => {
    const handler = handlerFor(button);
    const pending = button.action === 'call' && callPending;
    const ButtonIcon = button.icon;
    return (
      <button
        type="button"
        onClick={handler}
        disabled={handler === undefined || pending}
        className={cn(className, (handler === undefined || pending) && 'opacity-60')}
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
          <p className="text-muted-foreground mt-0.5 ml-7 truncate text-[13px] leading-relaxed">
            {nudge.sub}
          </p>
        )}
        {(nudge.primary || nudge.secondary) && (
          <div className="mt-2.5 ml-7 flex flex-wrap items-center gap-2">
            {nudge.primary && renderButton(nudge.primary, PRIMARY_CLASS)}
            {nudge.secondary && renderButton(nudge.secondary, SECONDARY_CLASS)}
          </div>
        )}
      </div>
    </div>
  );
}
