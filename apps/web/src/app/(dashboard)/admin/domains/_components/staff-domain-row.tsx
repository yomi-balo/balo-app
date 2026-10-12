'use client';

import { useCallback, useState } from 'react';
import { Globe, Loader2, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { removePartyDomainAction } from '../_actions/remove-party-domain';
import type { StaffPartyType } from '../_lib/staff-domain-types';
import { removeConfirmCopy, type StaffDomainRowView } from '../_lib/staff-domain-view';
import { ReasonField } from './reason-field';

const UNEXPECTED_ERROR = 'Something went wrong. Check the list before trying again.';

interface StaffDomainRowProps {
  row: StaffDomainRowView;
  partyType: StaffPartyType;
  partyId: string;
  partyName: string;
  isLast: boolean;
  canManage: boolean;
  /** Fired when a remove starts, so the page can clear the previous status line. */
  onBegin: () => void;
  onChanged: (message: string) => void;
}

/** One active domain: provenance badge and line, the audit reason, and (for managers) removal. */
export function StaffDomainRow({
  row,
  partyType,
  partyId,
  partyName,
  isLast,
  canManage,
  onBegin,
  onChanged,
}: Readonly<StaffDomainRowProps>): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  const startConfirm = useCallback((): void => setConfirming(true), []);
  const cancelConfirm = useCallback((): void => {
    setConfirming(false);
    setReasonError(null);
    setFormError(null);
  }, []);
  const handleReasonChange = useCallback((value: string): void => {
    setReason(value);
    setReasonError(null);
  }, []);

  const confirmRemove = useCallback(async (): Promise<void> => {
    setBusy(true);
    setFormError(null);
    onBegin();
    try {
      const result = await removePartyDomainAction({
        domainId: row.id,
        partyType,
        partyId,
        reason,
      });
      if (result.success) {
        toast.success(result.message);
        onChanged(result.message);
      } else if (result.field === 'reason') {
        setReasonError(result.error);
      } else {
        setFormError(result.error);
        toast.error(result.error);
        if (result.code === 'not_found') router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }, [row.id, partyType, partyId, reason, onBegin, onChanged, router]);

  const handleConfirm = useCallback((): void => {
    confirmRemove().catch((error: unknown) => {
      Sentry.captureException(error);
      toast.error(UNEXPECTED_ERROR);
    });
  }, [confirmRemove]);

  const isSignup = row.badge.tone === 'signup';

  return (
    <li className="py-3">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="bg-primary/10 text-primary flex h-9 w-9 flex-none items-center justify-center rounded-lg"
        >
          <Globe className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-foreground text-sm font-semibold [overflow-wrap:anywhere]">
              {row.domain}
            </span>
            <Badge
              variant="outline"
              className={cn(
                isSignup
                  ? 'bg-primary/10 text-primary border-primary/20'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              {row.badge.label}
            </Badge>
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">{row.meta}</p>
          {row.reason !== null && (
            <p className="border-border bg-muted/50 text-foreground mt-1.5 rounded-r-md border-l-2 px-2.5 py-1.5 text-xs leading-relaxed">
              {row.reason}
            </p>
          )}
        </div>
        {canManage && !confirming && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={startConfirm}
            aria-label={`Remove ${row.domain}`}
            className="text-destructive hover:text-destructive gap-1.5"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            Remove
          </Button>
        )}
      </div>

      {confirming && (
        <div className="border-destructive/25 bg-destructive/5 mt-3 flex flex-col gap-3 rounded-xl border px-4 py-3.5 sm:ml-12">
          <div>
            <p className="text-foreground text-sm font-semibold">{`Remove ${row.domain} from ${partyName}?`}</p>
            <p className="text-muted-foreground mt-1 text-[13px] leading-relaxed">
              {removeConfirmCopy(row.domain, partyName, isLast)}
            </p>
          </div>
          <ReasonField
            id={`remove-reason-${row.id}`}
            value={reason}
            onChange={handleReasonChange}
            error={reasonError}
            disabled={busy}
            autoFocus
          />
          {formError !== null && (
            <p role="alert" className="text-destructive text-xs font-medium">
              {formError}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-muted-foreground text-xs">
              {`Owners and admins of ${partyName} will be notified.`}
            </span>
            <div className="flex gap-1.5">
              <Button type="button" variant="ghost" size="sm" onClick={cancelConfirm}>
                Keep
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={handleConfirm}
                disabled={busy}
                className="gap-1.5"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Remove domain
              </Button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}
