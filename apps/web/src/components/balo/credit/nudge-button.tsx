'use client';

import { useCallback, useState, useTransition } from 'react';
import { Bell, Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { nudgeAdminAction } from '@/lib/credit/actions/session-mutations';

/**
 * BAL-378 (ADR-1040 Lane 2) — the member-lens nudge (§9, from `member-variant.jsx`).
 *
 * When "Top up" is not the member's to press, the constructive action is to nudge the
 * team's billing admin. On click it calls {@link nudgeAdminAction}; on success it toasts
 * and flips to the warm "We let {admin} know" confirmation. Team-framed, no "overdraft".
 */

interface NudgeButtonProps {
  sessionId: string;
  /** Button copy, e.g. "Ask Sam to top up" (already resolved by the drawdown state). */
  label: string;
  /** The billing admin's display name for the confirmation ("We let {admin} know"). */
  adminName?: string;
  /** `subtle` = light-fill secondary; `primary` = gradient fill (the wrap CTA). */
  tone?: 'primary' | 'subtle';
  /** Stretch to the container width. */
  block?: boolean;
  className?: string;
}

export function NudgeButton({
  sessionId,
  label,
  adminName,
  tone = 'primary',
  block = false,
  className,
}: Readonly<NudgeButtonProps>): React.JSX.Element {
  const [requested, setRequested] = useState(false);
  const [isPending, startTransition] = useTransition();

  const handleNudge = useCallback((): void => {
    startTransition(async () => {
      const result = await nudgeAdminAction(sessionId);
      if (result.success) {
        setRequested(true);
        toast.success(`We let ${adminName ?? 'your admin'} know`);
      } else {
        toast.error(result.error);
      }
    });
  }, [sessionId, adminName]);

  if (requested) {
    return (
      <output
        className={cn(
          'border-success/30 bg-success/10 text-success inline-flex items-center justify-center gap-1.5 rounded-[10px] border px-4 py-2.5 text-sm font-semibold',
          block && 'w-full',
          className
        )}
      >
        <Check className="size-[15px]" strokeWidth={2.6} aria-hidden />
        We let {adminName ?? 'your admin'} know
      </output>
    );
  }

  const isPrimary = tone === 'primary';

  return (
    <button
      type="button"
      onClick={handleNudge}
      disabled={isPending}
      className={cn(
        'focus-visible:ring-ring inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[10px] px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60',
        isPrimary
          ? 'from-primary bg-gradient-to-r to-violet-600 text-white shadow-sm'
          : 'border-primary/30 bg-primary/10 text-primary border',
        block && 'w-full',
        className
      )}
    >
      {isPending ? (
        <Loader2 className="size-[15px] animate-spin motion-reduce:animate-none" aria-hidden />
      ) : (
        <Bell className="size-[15px]" strokeWidth={2.5} aria-hidden />
      )}
      {label}
    </button>
  );
}
