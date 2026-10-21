'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { track, EXPERT_SETUP_EVENTS } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import type { LiveStatusView } from '@/lib/expert/live-status-view';
import type { LiveStatusAction } from '@balo/shared/experts';
import { LIVE_STATUS_TOKENS, liveStatusCopyFor } from './live-status-copy';

interface LiveStatusPillProps {
  readonly status: LiveStatusView;
  readonly variant: 'sidebar' | 'sheet';
  /** Close-before-act hook for the More sheet. */
  readonly onNavigate?: () => void;
}

const PILL_CLASSNAME =
  'inline-flex h-6 items-center gap-1.5 rounded-full px-[9px] text-xs font-semibold';

/** The expert's marketplace status as a pill with a popover explaining it and the fix. */
export function LiveStatusPill({
  status,
  variant,
  onNavigate,
}: Readonly<LiveStatusPillProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const { state } = status;
  const copy = liveStatusCopyFor(status);
  const { primary } = copy;
  const tokens = LIVE_STATUS_TOKENS[state];
  const actionClassName = variant === 'sheet' ? 'min-h-[44px]' : undefined;

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      setOpen(next);
      if (next) track(EXPERT_SETUP_EVENTS.LIVE_STATUS_OPENED, { state });
    },
    [state]
  );

  const handleAction = useCallback(
    (action: LiveStatusAction): void => {
      track(EXPERT_SETUP_EVENTS.LIVE_STATUS_ACTION, { state, action });
      setOpen(false);
      // A new tab leaves the sheet where it is; only same-tab links close it.
      if (action !== 'view_public_profile') onNavigate?.();
    },
    [state, onNavigate]
  );

  const pillContent = (
    <>
      <span aria-hidden="true" className={cn('size-[7px] rounded-full', tokens.dot)} />
      {copy.pill}
    </>
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {variant === 'sheet' ? (
          <button
            type="button"
            data-live-state={state}
            className="focus-visible:ring-ring inline-flex min-h-[44px] items-center rounded-full focus-visible:ring-2 focus-visible:outline-none"
          >
            <span className={cn(PILL_CLASSNAME, tokens.pill)}>{pillContent}</span>
          </button>
        ) : (
          <button
            type="button"
            data-live-state={state}
            className={cn(
              PILL_CLASSNAME,
              tokens.pill,
              'focus-visible:ring-ring cursor-pointer focus-visible:ring-2 focus-visible:outline-none'
            )}
          >
            {pillContent}
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        aria-label={copy.title}
        className="w-[272px] rounded-xl p-3.5 shadow-[0_12px_32px_rgba(15,23,42,0.14)]"
      >
        <p className="text-foreground text-sm font-semibold">{copy.title}</p>
        <p className="text-muted-foreground mt-1 mb-3 text-[13px] leading-[1.45]">{copy.body}</p>
        <div className="flex flex-wrap gap-2">
          {primary !== null && (
            <Button size="sm" asChild className={actionClassName}>
              <Link href={primary.href} onClick={() => handleAction(primary.action)}>
                {primary.label}
              </Link>
            </Button>
          )}
          {status.publicProfileHref !== null && (
            <Button size="sm" variant="outline" asChild className={actionClassName}>
              <a
                href={status.publicProfileHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => handleAction('view_public_profile')}
              >
                View public profile<span className="sr-only"> (opens in new tab)</span>
                <ExternalLink size={13} aria-hidden="true" />
              </a>
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
