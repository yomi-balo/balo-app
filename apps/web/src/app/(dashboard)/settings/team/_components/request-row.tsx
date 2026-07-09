'use client';

import { useCallback } from 'react';
import { AlertTriangle, Check, Clock, X } from 'lucide-react';
import type { PendingJoinRequestRow } from '@balo/db';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { formatShortDate } from '@/components/balo/domain-join/format';
import { cn } from '@/lib/utils';

interface RequestRowProps {
  request: PendingJoinRequestRow;
  hasError: boolean;
  disabled: boolean;
  onApprove: (id: string) => void;
  onDecline: (id: string) => void;
}

function initialsOf(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

/**
 * One pending join-request row (BAL-347 company queue): avatar, name, email ·
 * requested date, then ghost Decline + success-solid Approve (neither is the
 * gradient CTA — that is reserved for Add domain). On an optimistic-rollback error
 * the row shakes (reduced-motion-safe via globals) and shows an inline banner.
 */
export function RequestRow({
  request,
  hasError,
  disabled,
  onApprove,
  onDecline,
}: Readonly<RequestRowProps>): React.JSX.Element {
  const { requester } = request;
  const fullName = [requester.firstName, requester.lastName].filter(Boolean).join(' ').trim();
  const displayName = fullName.length > 0 ? fullName : requester.email;
  const firstName = requester.firstName ?? displayName;

  const handleApprove = useCallback(() => onApprove(request.id), [onApprove, request.id]);
  const handleDecline = useCallback(() => onDecline(request.id), [onDecline, request.id]);

  return (
    <div className={cn('py-1', hasError && 'animate-shake')}>
      <div className="flex items-center gap-3">
        <Avatar className="h-9 w-9 flex-none">
          <AvatarFallback className="from-primary bg-gradient-to-br to-purple-600 text-xs font-bold text-white">
            {initialsOf(displayName)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="text-foreground text-sm font-semibold">{displayName}</div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
            <span>{requester.email}</span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3 w-3" aria-hidden="true" />
              Requested {formatShortDate(request.createdAt)}
            </span>
          </div>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleDecline}
            disabled={disabled}
            className="text-muted-foreground gap-1.5"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Decline
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleApprove}
            disabled={disabled}
            className="bg-success text-success-foreground hover:bg-success/90 gap-1.5"
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Approve
          </Button>
        </div>
      </div>
      {hasError && (
        <div
          role="alert"
          className="border-destructive/25 bg-destructive/10 text-destructive mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden="true" />
          <span>{`Couldn't update — ${firstName} is still waiting. Nothing changed; try again.`}</span>
        </div>
      )}
    </div>
  );
}
