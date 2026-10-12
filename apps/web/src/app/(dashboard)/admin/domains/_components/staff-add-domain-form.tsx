'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowRightLeft, Loader2, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { validateDomainInput } from '@/lib/domain-input';
import { cn } from '@/lib/utils';
import { addPartyDomainAction } from '../_actions/add-party-domain';
import { reassignPartyDomainAction } from '../_actions/reassign-party-domain';
import type {
  ConflictOwnerView,
  StaffDomainActionResult,
  StaffPartyType,
} from '../_lib/staff-domain-types';
import { addNotifyLine } from '../_lib/staff-domain-view';
import { ConflictPanel } from './conflict-panel';
import { ReasonField } from './reason-field';

const UNEXPECTED_ERROR = 'Something went wrong. Check the list before trying again.';

interface StaffAddDomainFormProps {
  partyType: StaffPartyType;
  partyId: string;
  partyName: string;
  /** Fired when a submit starts, so the page can clear the previous status line. */
  onBegin: () => void;
  onChanged: (message: string) => void;
}

interface Conflict {
  domain: string;
  owner: ConflictOwnerView;
}

/**
 * Adds a domain to this party. If another party owns it the conflict panel appears and the
 * submit button becomes "Reassign to {party}"; the second press reassigns, naming the owner the
 * staffer was shown so a change in between is refused rather than overwritten.
 */
export function StaffAddDomainForm({
  partyType,
  partyId,
  partyName,
  onBegin,
  onChanged,
}: Readonly<StaffAddDomainFormProps>): React.JSX.Element {
  const domainId = useId();
  const domainErrorId = useId();
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [domainError, setDomainError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const reasonId = `${domainId}-reason`;
  // Focus can only land once the controls are re-enabled, so the target waits for `busy` to clear.
  const pendingFocus = useRef<'domain' | 'reason' | null>(null);

  useEffect(() => {
    if (busy || pendingFocus.current === null) return;
    const target =
      pendingFocus.current === 'domain' ? inputRef.current : document.getElementById(reasonId);
    pendingFocus.current = null;
    target?.focus();
  }, [busy, reasonId]);

  const reset = useCallback((): void => {
    setValue('');
    setReason('');
    setConflict(null);
    setDomainError(null);
    setReasonError(null);
    setFormError(null);
    pendingFocus.current = 'domain';
  }, []);

  const applyFailure = useCallback(
    (result: Extract<StaffDomainActionResult, { success: false }>, domain: string): void => {
      if (result.code === 'owned_by_other' && result.owner !== undefined) {
        setConflict({ domain, owner: result.owner });
        pendingFocus.current = 'reason';
        return;
      }
      if (result.field === 'domain') {
        setDomainError(result.error);
        setConflict(null);
        return;
      }
      if (result.field === 'reason') {
        setReasonError(result.error);
        return;
      }
      if (result.code === 'stale') {
        setConflict(null);
        router.refresh();
      }
      setFormError(result.error);
      toast.error(result.error);
    },
    [router]
  );

  const submit = useCallback(async (): Promise<void> => {
    const validation = validateDomainInput(value);
    if (!validation.ok) {
      setDomainError(validation.error);
      setConflict(null);
      return;
    }
    setBusy(true);
    setFormError(null);
    onBegin();
    try {
      const result =
        conflict === null
          ? await addPartyDomainAction({ partyType, partyId, domain: validation.domain, reason })
          : await reassignPartyDomainAction({
              expectedDomainId: conflict.owner.domainId,
              fromPartyType: conflict.owner.partyType,
              fromPartyId: conflict.owner.partyId,
              toPartyType: partyType,
              toPartyId: partyId,
              domain: conflict.domain,
              reason,
            });
      if (result.success) {
        toast.success(result.message);
        onChanged(result.message);
        reset();
      } else {
        applyFailure(result, validation.domain);
      }
    } finally {
      setBusy(false);
    }
  }, [value, conflict, partyType, partyId, reason, onBegin, onChanged, reset, applyFailure]);

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      submit().catch((error: unknown) => {
        Sentry.captureException(error);
        toast.error(UNEXPECTED_ERROR);
      });
    },
    [submit]
  );

  const handleDomainChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    setValue(event.target.value.toLowerCase());
    setDomainError(null);
    setFormError(null);
    setConflict(null);
  }, []);

  const handleReasonChange = useCallback((next: string): void => {
    setReason(next);
    setReasonError(null);
  }, []);

  const cancelConflict = useCallback((): void => setConflict(null), []);

  const hasDomainError = domainError !== null;

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      <div className="space-y-1.5">
        <Label htmlFor={domainId} className="text-muted-foreground text-xs font-semibold">
          Domain
        </Label>
        <Input
          id={domainId}
          ref={inputRef}
          value={value}
          onChange={handleDomainChange}
          placeholder="acme.co.nz"
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          disabled={busy}
          aria-invalid={hasDomainError}
          aria-describedby={hasDomainError ? domainErrorId : undefined}
          className={cn('h-11', hasDomainError && 'border-destructive')}
        />
        {hasDomainError && (
          <p id={domainErrorId} role="alert" className="text-destructive text-xs font-medium">
            {domainError}
          </p>
        )}
      </div>

      <div aria-live="polite" className="sr-only">
        {conflict !== null &&
          `${conflict.domain} belongs to ${conflict.owner.partyName}. The button now reads Reassign to ${partyName}.`}
      </div>

      {conflict !== null && (
        <ConflictPanel domain={conflict.domain} owner={conflict.owner} targetName={partyName} />
      )}

      <ReasonField
        id={reasonId}
        value={reason}
        onChange={handleReasonChange}
        error={reasonError}
        disabled={busy}
      />

      {formError !== null && (
        <p role="alert" className="text-destructive text-sm font-medium">
          {formError}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs">
          {addNotifyLine(partyName, conflict === null ? null : conflict.owner.partyName)}
        </span>
        <div className="flex gap-1.5">
          {conflict !== null && (
            <Button type="button" variant="ghost" onClick={cancelConflict}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={busy} className="gap-2">
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {!busy && conflict === null && <Plus className="h-4 w-4" aria-hidden="true" />}
            {!busy && conflict !== null && (
              <ArrowRightLeft className="h-4 w-4" aria-hidden="true" />
            )}
            {conflict === null ? 'Add domain' : `Reassign to ${partyName}`}
          </Button>
        </div>
      </div>
    </form>
  );
}
