'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Loader2, Pencil, Receipt } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  billingDetailsSchema,
  type BillingDetailsInput,
} from '@/app/(dashboard)/projects/[requestId]/_actions/billing-details-schema';
import { submitBillingDetailsAction } from '@/app/(dashboard)/projects/[requestId]/_actions/submit-billing-details';
import { BILLING_COUNTRIES, getTaxIdLabel } from '@/lib/billing/tax-id-labels';
import type { CapturedBillingDetails } from '@/lib/billing/billing-capture';

type DialogMode = 'create' | 'view';

interface BillingDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: DialogMode;
  requestId: string;
  relationshipId: string;
  /** Existing row — prefills the form (edit) and drives the read-only view. */
  details: CapturedBillingDetails | null;
}

function countryName(code: string): string {
  return BILLING_COUNTRIES.find((c) => c.code === code)?.name ?? code;
}

function toFormValues(details: CapturedBillingDetails | null): BillingDetailsInput {
  return {
    legalName: details?.legalName ?? '',
    countryCode: details?.countryCode ?? '',
    taxId: details?.taxId ?? '',
    address: details?.address ?? '',
    billingEmail: details?.billingEmail ?? '',
  };
}

/**
 * The billing-details capture dialog (BAL-323). Owns the four states: the form
 * (create or edit), submitting, error (inline `FormMessage` + toast), and — for a
 * confirmed company (`mode='view'`) — a read-only summary with an Edit affordance.
 * On success it toasts, refreshes the server tree (the action already confirmed the
 * kickoff gate + revalidated), and closes.
 */
export function BillingDetailsDialog({
  open,
  onOpenChange,
  mode,
  requestId,
  relationshipId,
  details,
}: Readonly<BillingDetailsDialogProps>): React.JSX.Element {
  const router = useRouter();
  // `view` opens read-only; Edit flips it into the form. `create` is always the form.
  const [editing, setEditing] = useState(mode === 'create');

  const form = useForm<BillingDetailsInput>({
    resolver: zodResolver(billingDetailsSchema),
    defaultValues: toFormValues(details),
  });
  const { isSubmitting } = form.formState;

  const selectedCountry = form.watch('countryCode');
  const taxId = getTaxIdLabel(selectedCountry ?? '');

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (isSubmitting && !next) return; // no dismiss mid-submit
      if (!next) {
        // Reset to the pristine (view or empty) state for the next open.
        setEditing(mode === 'create');
        form.reset(toFormValues(details));
      }
      onOpenChange(next);
    },
    [isSubmitting, mode, details, form, onOpenChange]
  );

  const onSubmit = useCallback(
    async (values: BillingDetailsInput): Promise<void> => {
      const result = await submitBillingDetailsAction({ requestId, relationshipId, ...values });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success('Billing details saved');
      onOpenChange(false);
      router.refresh();
    },
    [requestId, relationshipId, onOpenChange, router]
  );

  const showReadOnly = !editing && details !== null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!isSubmitting}
        className="max-h-[88vh] overflow-y-auto sm:max-w-[520px]"
      >
        <DialogHeader className="text-left">
          <div className="flex items-center gap-3">
            <span className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-xl">
              <Receipt className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-base font-semibold">
                {showReadOnly ? 'Billing details' : 'Add billing details'}
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-xs">
                {showReadOnly
                  ? 'Balo invoices your company using these details.'
                  : 'Balo raises the upfront invoice from these details — this unblocks kickoff.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {showReadOnly ? (
          <BillingDetailsSummary details={details} onEdit={() => setEditing(true)} />
        ) : (
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-4">
              <FormField
                control={form.control}
                name="legalName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Legal / entity name</FormLabel>
                    <FormControl>
                      <Input placeholder="Acme Pty Ltd" autoComplete="organization" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="countryCode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Country</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a country" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {BILLING_COUNTRIES.map((country) => (
                          <SelectItem key={country.code} value={country.code}>
                            {country.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="taxId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{taxId.label}</FormLabel>
                    <FormControl>
                      <Input placeholder={taxId.placeholder} {...field} />
                    </FormControl>
                    <FormDescription>
                      Shown on your invoices — the label follows your country.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="address"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Billing address (optional)</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={2}
                        placeholder="Street, city, postcode"
                        autoComplete="street-address"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="billingEmail"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Billing email</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        inputMode="email"
                        placeholder="accounts@acme.com"
                        autoComplete="email"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>Where Balo sends your invoices.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter className="gap-2 sm:gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => handleOpenChange(false)}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting} className="gap-2">
                  {isSubmitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Check className="h-4 w-4" aria-hidden="true" />
                  )}
                  {isSubmitting ? 'Saving…' : 'Save billing details'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Read-only summary of the captured details (the confirmed success state). */
function BillingDetailsSummary({
  details,
  onEdit,
}: Readonly<{ details: CapturedBillingDetails; onEdit: () => void }>): React.JSX.Element {
  const taxId = getTaxIdLabel(details.countryCode);
  const rows: { label: string; value: string }[] = [
    { label: 'Legal / entity name', value: details.legalName },
    { label: 'Country', value: countryName(details.countryCode) },
    { label: taxId.label, value: details.taxId ?? '—' },
    ...(details.address ? [{ label: 'Billing address', value: details.address }] : []),
    { label: 'Billing email', value: details.billingEmail },
  ];

  return (
    <div className="space-y-4">
      <dl className="divide-border divide-y">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[minmax(0,140px)_1fr] gap-3 py-2.5">
            <dt className="text-muted-foreground text-sm">{row.label}</dt>
            <dd className="text-foreground text-sm font-medium break-words">{row.value}</dd>
          </div>
        ))}
      </dl>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onEdit} className="gap-2">
          <Pencil className="h-4 w-4" aria-hidden="true" />
          Edit details
        </Button>
      </DialogFooter>
    </div>
  );
}

interface ClientBillingAffordanceProps {
  /** The gate is confirmed (`request.clientBillingConfirmedAt !== null`). */
  done: boolean;
  /** The viewer may submit/edit (company owner/admin). */
  canManage: boolean;
  requestId: string;
  relationshipId: string;
  details: CapturedBillingDetails | null;
}

/**
 * The client's billing row affordance on the kickoff board. Replaces the generic
 * "Complete" button with the capture flow: owner/admin get a form (or a View/Edit
 * dialog once confirmed); a plain member gets a muted "owner/admin only" marker
 * (the "what happens next" notice is the row's sub-copy — see KickoffBoard).
 */
export function ClientBillingAffordance({
  done,
  canManage,
  requestId,
  relationshipId,
  details,
}: Readonly<ClientBillingAffordanceProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);

  if (done) {
    // Confirmed. Owner/admin can re-open the captured details (read-only + edit);
    // a member — or a legacy confirm with no row — just sees "Done".
    if (canManage && details !== null) {
      return (
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="text-success text-xs font-semibold">Done</span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="View billing details"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -mx-1.5 -my-1 inline-flex min-h-9 items-center rounded-md px-1.5 py-1 text-xs font-medium underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
          >
            View
          </button>
          <BillingDetailsDialog
            open={open}
            onOpenChange={setOpen}
            mode="view"
            requestId={requestId}
            relationshipId={relationshipId}
            details={details}
          />
        </div>
      );
    }
    return <span className="text-success shrink-0 text-xs font-semibold">Done</span>;
  }

  if (!canManage) {
    // A plain member — the row sub-copy frames what happens next; the affordance
    // itself is a muted, non-actionable marker (never a disabled-looking button).
    return (
      <span className="text-muted-foreground shrink-0 text-xs font-medium">Owner/admin only</span>
    );
  }

  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)} className="shrink-0">
        Add details
      </Button>
      <BillingDetailsDialog
        open={open}
        onOpenChange={setOpen}
        mode="create"
        requestId={requestId}
        relationshipId={relationshipId}
        details={details}
      />
    </>
  );
}
