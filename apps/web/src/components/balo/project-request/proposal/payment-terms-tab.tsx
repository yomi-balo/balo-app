'use client';

import { useCallback, useState } from 'react';
import { Lock, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { centsToDollars, dollarsToCents, formatWholeCurrency } from '@/lib/utils/currency';
import { ProposalDocumentUploader } from './proposal-document-uploader';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';
import type {
  ProposalCadenceValue,
  ProposalInstallmentDraft,
  ProposalPricingMethod,
} from './proposal-composer-state';

interface PaymentTermsTabProps {
  pricingMethod: ProposalPricingMethod;
  totalCents: number;
  /** ISO currency code from draft state (drives grouped whole-dollar display). */
  currency: string;
  installments: ProposalInstallmentDraft[];
  installmentSum: number;
  onInstallmentsChange: (next: ProposalInstallmentDraft[]) => void;
  onAddInstallment: () => void;
  depositCents: number | null;
  onDepositChange: (cents: number | null) => void;
  rateCents: number | null;
  onRateChange: (cents: number | null) => void;
  cadence: ProposalCadenceValue;
  onCadenceChange: (cadence: ProposalCadenceValue) => void;
  // Terms-supplement uploader wiring.
  requestId: string;
  relationshipId: string;
  termsDocuments: ProposalDocumentView[];
  ensureProposalId: () => Promise<string | null>;
  onDocumentAdded: (document: ProposalDocumentView) => void;
  onDocumentRemoved: (documentId: string) => void;
}

function parseDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number.parseFloat(trimmed);
  if (Number.isNaN(parsed) || parsed < 0) return null;
  return dollarsToCents(parsed);
}

const CADENCE_OPTIONS: { value: ProposalCadenceValue; label: string }[] = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'fortnightly', label: 'Fortnightly' },
];

const STANDARD_TERMS = [
  'Work is delivered against the milestones and scope set out in this proposal.',
  'Invoices are issued via Balo; payment is held and released through the platform.',
  'Either party may raise a dispute through Balo support before final acceptance.',
  'Confidential information shared during the engagement stays confidential.',
];

/**
 * Adaptive payment & terms pane. A read-only method note (change it in Overview),
 * then either the Fixed installment %-editor (live sum-to-100 badge) or the T&M
 * deposit / rate / cadence inputs. Both show the non-editable Balo standard-terms
 * block plus the optional single terms-supplement uploader.
 */
export function PaymentTermsTab({
  pricingMethod,
  totalCents,
  currency,
  installments,
  installmentSum,
  onInstallmentsChange,
  onAddInstallment,
  depositCents,
  onDepositChange,
  rateCents,
  onRateChange,
  cadence,
  onCadenceChange,
  requestId,
  relationshipId,
  termsDocuments,
  ensureProposalId,
  onDocumentAdded,
  onDocumentRemoved,
}: Readonly<PaymentTermsTabProps>): React.JSX.Element {
  const [termsOpen, setTermsOpen] = useState(false);
  const isFixed = pricingMethod === 'fixed';

  const patchInstallment = useCallback(
    (index: number, partial: Partial<ProposalInstallmentDraft>): void => {
      onInstallmentsChange(
        installments.map((inst, i) => (i === index ? { ...inst, ...partial } : inst))
      );
    },
    [installments, onInstallmentsChange]
  );

  const removeInstallment = useCallback(
    (index: number): void => {
      onInstallmentsChange(installments.filter((_, i) => i !== index));
    },
    [installments, onInstallmentsChange]
  );

  const handlePct = useCallback(
    (index: number) =>
      (event: React.ChangeEvent<HTMLInputElement>): void => {
        const raw = event.target.value.trim();
        const parsed = raw === '' ? 0 : Number.parseInt(raw, 10);
        const clamped = Number.isNaN(parsed) ? 0 : Math.min(100, Math.max(0, parsed));
        patchInstallment(index, { pct: clamped });
      },
    [patchInstallment]
  );

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-[13px]">
        Pricing method:{' '}
        <span className="text-foreground font-semibold">
          {isFixed ? 'Fixed price' : 'Time & materials'}
        </span>{' '}
        — change it in the Overview tab.
      </p>

      {isFixed ? (
        <div className="space-y-3">
          <div className="border-border bg-muted/30 flex items-center justify-between rounded-[12px] border px-4 py-3">
            <span className="text-foreground text-sm font-medium">Total from milestones</span>
            <span className="text-foreground font-mono text-sm font-semibold tabular-nums">
              {formatWholeCurrency(totalCents, currency)}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <Label className="text-foreground text-sm font-medium">Payment installments</Label>
            <Badge variant={installmentSum === 100 ? 'default' : 'destructive'}>
              {installmentSum}%
            </Badge>
          </div>

          <ul className="space-y-2">
            {installments.map((inst, index) => {
              const labelId = `installment-label-${inst.key}`;
              const pctId = `installment-pct-${inst.key}`;
              const amount = Math.round((totalCents * inst.pct) / 100);
              return (
                <li
                  key={inst.key}
                  className="border-border bg-card flex flex-wrap items-end gap-3 rounded-[10px] border p-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <Label htmlFor={labelId} className="text-[12px]">
                      Label
                    </Label>
                    <Input
                      id={labelId}
                      value={inst.label}
                      onChange={(e) => patchInstallment(index, { label: e.target.value })}
                      placeholder="e.g. Upfront"
                    />
                  </div>
                  <div className="w-24 space-y-1">
                    <Label htmlFor={pctId} className="text-[12px]">
                      %
                    </Label>
                    <Input
                      id={pctId}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={100}
                      value={inst.pct}
                      onChange={handlePct(index)}
                    />
                  </div>
                  <div className="text-muted-foreground min-w-[5rem] pb-2.5 text-right font-mono text-[13px] tabular-nums">
                    {formatWholeCurrency(amount, currency)}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeInstallment(index)}
                    disabled={installments.length === 1}
                    aria-label={`Remove installment ${index + 1}`}
                    className="text-muted-foreground hover:text-destructive focus-visible:ring-ring mb-1.5 flex h-9 w-9 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-30"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            onClick={onAddInstallment}
            className="border-border text-foreground hover:bg-muted/50 focus-visible:ring-ring inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-dashed px-4 text-[13px] font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add installment
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="proposal-deposit">Deposit</Label>
              <div className="relative">
                <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm">
                  A$
                </span>
                <Input
                  id="proposal-deposit"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  className="pl-9"
                  value={depositCents === null ? '' : centsToDollars(depositCents)}
                  onChange={(e) => onDepositChange(parseDollarsToCents(e.target.value))}
                  placeholder="0.00"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="proposal-rate">Hourly rate</Label>
              <div className="relative">
                <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm">
                  A$
                </span>
                <Input
                  id="proposal-rate"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  className="pr-12 pl-9"
                  value={rateCents === null ? '' : centsToDollars(rateCents)}
                  onChange={(e) => onRateChange(parseDollarsToCents(e.target.value))}
                  placeholder="0.00"
                />
                <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm">
                  /hr
                </span>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="proposal-cadence">Invoicing cadence</Label>
            <Select
              value={cadence}
              onValueChange={(value) => onCadenceChange(value as ProposalCadenceValue)}
            >
              <SelectTrigger id="proposal-cadence" className="w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CADENCE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="text-muted-foreground border-border bg-muted/30 rounded-[10px] border px-3 py-2.5 text-[13px]">
            The milestone estimate ({formatWholeCurrency(totalCents, currency)}) is shown as a
            guide, not a cap.
          </p>
        </div>
      )}

      <div className="border-border space-y-4 border-t pt-5">
        <div className="border-border bg-muted/30 flex items-start gap-3 rounded-[12px] border p-4">
          <span className="bg-primary/10 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
            <ShieldCheck className="text-primary h-4.5 w-4.5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <Lock className="text-muted-foreground h-3.5 w-3.5" aria-hidden="true" />
              <span className="text-foreground text-sm font-semibold">Balo standard terms</span>
            </div>
            <p className="text-muted-foreground mt-0.5 text-[13px] leading-relaxed">
              These apply to every proposal and can&apos;t be edited.
            </p>
          </div>
          <Popover open={termsOpen} onOpenChange={setTermsOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="border-border bg-card text-foreground hover:bg-muted/50 focus-visible:ring-ring shrink-0 rounded-md border px-3 py-1.5 text-[12px] font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                View
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
              <p className="text-foreground mb-2 text-sm font-semibold">Balo standard terms</p>
              <ul className="text-muted-foreground space-y-2 text-[13px] leading-relaxed">
                {STANDARD_TERMS.map((term) => (
                  <li key={term} className="flex gap-2">
                    <span className="text-primary mt-1.5 h-1 w-1 shrink-0 rounded-full bg-current" />
                    {term}
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        </div>

        <div className={cn('space-y-2')}>
          <Label id="terms-supplement-label" className="text-foreground text-sm font-medium">
            Terms supplement (optional)
          </Label>
          <p className="text-muted-foreground text-[13px]">
            Add your own terms document to sit alongside the standard terms. One file.
          </p>
          <ProposalDocumentUploader
            requestId={requestId}
            relationshipId={relationshipId}
            documents={termsDocuments}
            kind="terms"
            single
            ensureProposalId={ensureProposalId}
            onAdded={onDocumentAdded}
            onRemoved={onDocumentRemoved}
            labelId="terms-supplement-label"
          />
        </div>
      </div>
    </div>
  );
}
