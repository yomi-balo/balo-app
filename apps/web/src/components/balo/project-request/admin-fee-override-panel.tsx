'use client';

import { useCallback, useEffect, useId, useRef, useState, useTransition } from 'react';
import { Loader2, Pencil, Percent } from 'lucide-react';
import { toast } from 'sonner';
import {
  DEFAULT_BALO_FEE_BPS,
  feeBpsToPercent,
  formatFeePercent,
  parseFeePercentToBps,
  type ParseFeeResult,
} from '@balo/shared/pricing';
import { overrideBaloFee } from '@/app/(dashboard)/projects/[requestId]/_actions/override-balo-fee';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RequestCard } from './request-card';

interface AdminFeeOverridePanelProps {
  requestId: string;
  /** The request's live fee, in basis points (observer lens only — never null here). */
  baloFeeBps: number;
}

type ParseFailureReason = Extract<ParseFeeResult, { ok: false }>['reason'];

/** Client-side validation reason → the message the admin sees. */
const PARSE_ERROR_COPY: Record<ParseFailureReason, string> = {
  empty: 'Enter a percentage, e.g. 17.5.',
  not_a_number: 'Enter a percentage, e.g. 17.5.',
  too_many_decimals: 'Use at most 2 decimal places.',
  out_of_range: 'Enter a fee between 0% and 100%.',
};

const SEMANTICS_COPY =
  'Applies to proposals submitted from now on. Already-submitted proposals keep the fee they were sent with.';

/**
 * BAL-358 — admin-only inline Balo-fee override (observer lens). Renders the live
 * fee as a percent with a "Default" badge when it equals `DEFAULT_BALO_FEE_BPS`,
 * and an Edit → Save/Cancel inline editor. Client-side validation (via the shared
 * `parseFeePercentToBps`) blocks an invalid submit before the server round-trip;
 * the retryable error keeps the typed value and states what failed. Toasts every
 * mutation. There is no empty state — the field always has a value (the shell only
 * mounts this when `baloFeeBps !== null`).
 *
 * All pricing helpers + `DEFAULT_BALO_FEE_BPS` are imported from the
 * `@balo/shared/pricing` SUBPATH (never the package root / `@balo/db`) so the
 * postgres/pino barrels never reach the client bundle. Fee analytics is
 * server-side only — this component fires no `track()`.
 */
export function AdminFeeOverridePanel({
  requestId,
  baloFeeBps,
}: Readonly<AdminFeeOverridePanelProps>): React.JSX.Element {
  const [bps, setBps] = useState(baloFeeBps);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [value, setValue] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const wasEditingRef = useRef<boolean>(false);

  // Keyboard focus management: when the inline editor opens, move focus to the
  // input (and select its seeded value); when it closes, return focus to the
  // Edit trigger that opened it. The `wasEditingRef` guard keeps the effect from
  // stealing focus to the Edit button on the initial (view-mode) mount.
  useEffect((): void => {
    if (mode === 'edit') {
      inputRef.current?.focus();
      inputRef.current?.select();
      wasEditingRef.current = true;
    } else if (wasEditingRef.current) {
      editButtonRef.current?.focus();
      wasEditingRef.current = false;
    }
  }, [mode]);

  const startEditing = useCallback((): void => {
    setValue(String(feeBpsToPercent(bps)));
    setErrorMsg(null);
    setMode('edit');
  }, [bps]);

  const cancelEditing = useCallback((): void => {
    setErrorMsg(null);
    setMode('view');
  }, []);

  const handleChange = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    setValue(event.target.value);
    setErrorMsg(null);
  }, []);

  const save = useCallback((): void => {
    if (isPending) return;
    const parsed = parseFeePercentToBps(value);
    if (!parsed.ok) {
      setErrorMsg(PARSE_ERROR_COPY[parsed.reason]);
      return;
    }
    setErrorMsg(null);
    startTransition(async (): Promise<void> => {
      const res = await overrideBaloFee({ requestId, feeBps: parsed.bps });
      if (!res.success) {
        // Retryable: keep edit mode + the typed value, state what failed.
        setErrorMsg(res.error);
        toast.error(res.error);
        return;
      }
      setBps(res.newBps);
      setMode('view');
      toast.success(
        res.changed ? `Balo fee updated to ${formatFeePercent(res.newBps)}` : 'Fee unchanged.'
      );
    });
  }, [isPending, value, requestId]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Enter') {
        event.preventDefault();
        save();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelEditing();
      }
    },
    [save, cancelEditing]
  );

  const isDefault = bps === DEFAULT_BALO_FEE_BPS;

  return (
    <RequestCard className="p-6">
      <div className="mb-4 flex items-center gap-2">
        <span className="bg-info/10 border-info/20 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border">
          <Percent className="text-info h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <h3 className="text-foreground text-sm font-semibold">Balo fee</h3>
      </div>

      {mode === 'view' ? (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span className="text-foreground font-mono text-lg font-semibold tabular-nums">
              {formatFeePercent(bps)}
            </span>
            {isDefault && (
              <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[11px] font-medium">
                Default
              </span>
            )}
          </div>
          <Button
            ref={editButtonRef}
            type="button"
            variant="outline"
            onClick={startEditing}
            className="min-h-11 gap-1.5"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            Edit
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <label
              htmlFor={inputId}
              className="text-muted-foreground mb-1.5 block text-xs font-medium"
            >
              Fee (%)
            </label>
            <div className="relative">
              <Input
                ref={inputRef}
                id={inputId}
                inputMode="decimal"
                autoComplete="off"
                value={value}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                disabled={isPending}
                aria-invalid={errorMsg !== null}
                aria-describedby={errorMsg === null ? undefined : errorId}
                className="pr-7 font-mono tabular-nums"
              />
              <span
                className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm"
                aria-hidden="true"
              >
                %
              </span>
            </div>
            {errorMsg !== null && (
              <p id={errorId} className="text-destructive mt-1.5 text-xs">
                {errorMsg}
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={cancelEditing}
              disabled={isPending}
              className="min-h-11"
            >
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={isPending} className="min-h-11">
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Saving…
                </>
              ) : (
                'Save'
              )}
            </Button>
          </div>
        </div>
      )}

      <p className="text-muted-foreground mt-4 text-xs leading-relaxed">{SEMANTICS_COPY}</p>
    </RequestCard>
  );
}
