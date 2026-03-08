'use client';

import { useState, useCallback, useRef } from 'react';
import { motion } from 'motion/react';
import {
  CreditCard,
  AlertCircle,
  RefreshCw,
  Lock,
  Globe,
  ShieldCheck,
  Zap,
  Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { IconBadge } from '@/components/balo/icon-badge';
import { track, EXPERT_PAYOUT_EVENTS } from '@/lib/analytics';
import { PayoutCountrySelector } from './payout-country-selector';
import { PayoutDynamicForm } from './payout-dynamic-form';
import { PayoutSavedState } from './payout-saved-state';
import { savePayoutDetailsAction } from '../_actions/save-payout-details';

// ── Types ───────────────────────────────────────────────────────

export interface NormalizedField {
  path: string;
  required: boolean;
  label: string;
  description?: string;
  placeholder?: string;
  tip?: string;
  type: 'text' | 'enum';
  options?: Array<{ label: string; value: string }>;
  defaultValue?: string;
  refresh: boolean;
  validation?: { pattern: string };
  wide?: boolean;
}

export interface PayoutDetailsSummary {
  countryCode: string;
  currency: string;
  transferMethod: string;
  entityType: string;
  formValues: Record<string, string>;
  verifiedAt: string | null;
}

interface PayoutsTabProps {
  initialPayoutDetails: PayoutDetailsSummary | null;
}

type TabState = 'empty' | 'form' | 'saved';

// ── Fields auto-populated from country selection (hide from form) ──

const HIDDEN_FIELD_KEYS = new Set([
  'beneficiary.entity_type',
  'beneficiary.bank_details.bank_country_code',
  'beneficiary.bank_details.account_currency',
  'beneficiary.bank_details.local_clearing_system',
  // Transfer method is auto-populated by the system — never shown in the form.
  // Include path variants since Airwallex nesting can differ by schema version.
  'beneficiary.bank_details.transfer_method',
  'transfer_method',
]);

// ── Animation variants ──────────────────────────────────────────

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
} as const;

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' as const } },
};

// ── Component ───────────────────────────────────────────────────

export function PayoutsTab({ initialPayoutDetails }: PayoutsTabProps): React.JSX.Element {
  const [state, setState] = useState<TabState>(initialPayoutDetails ? 'saved' : 'empty');
  const [countryCode, setCountryCode] = useState(initialPayoutDetails?.countryCode ?? '');
  const [currency, setCurrency] = useState(initialPayoutDetails?.currency ?? '');
  const [transferMethod] = useState(initialPayoutDetails?.transferMethod ?? 'LOCAL');
  const [entityType] = useState(initialPayoutDetails?.entityType ?? 'PERSONAL');

  const [schemaFields, setSchemaFields] = useState<NormalizedField[] | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>(
    initialPayoutDetails?.formValues ?? {}
  );
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});

  const [isFetchingSchema, setIsFetchingSchema] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [savedDetails, setSavedDetails] = useState<PayoutDetailsSummary | null>(
    initialPayoutDetails
  );

  const formStartedRef = useRef(false);
  const formValuesRef = useRef(formValues);
  formValuesRef.current = formValues;

  // Visible fields: strip auto-populated metadata fields, single-option enums, and optional fields.
  // Optional fields are either Airwallex internal labels (nickname), data Balo already holds
  // (email — passed server-side from the expert's profile), or genuinely not needed for transfers.
  // Also strip by label as a catch-all — Airwallex returns transfer_method in varying shapes.
  const visibleFields =
    schemaFields?.filter(
      (f) =>
        f.required &&
        !HIDDEN_FIELD_KEYS.has(f.path) &&
        !(f.type === 'enum' && f.options && f.options.length <= 1) &&
        !f.label.toLowerCase().includes('transfer method')
    ) ?? null;

  // ── Schema fetching ─────────────────────────────────────────

  const fetchSchema = useCallback(
    async (
      country: string,
      curr?: string,
      method?: string,
      entType?: string,
      preserveValues?: Record<string, string>
    ) => {
      setIsFetchingSchema(true);
      setSchemaError(null);
      setSchemaFields(null);

      try {
        const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002';
        const params = new URLSearchParams({ country });
        if (curr) params.set('currency', curr);
        if (method) params.set('method', method);
        if (entType) params.set('entity_type', entType);

        const res = await fetch(`${apiBase}/api/payouts/schema?${params.toString()}`);

        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error ?? 'Failed to fetch schema');
        }

        const data = (await res.json()) as { fields: NormalizedField[] };
        setSchemaFields(data.fields);

        // Populate defaults and preserve existing values
        const defaults: Record<string, string> = {};
        for (const field of data.fields) {
          if (preserveValues?.[field.path] != null) {
            defaults[field.path] = preserveValues[field.path] as string;
          } else if (field.defaultValue) {
            defaults[field.path] = field.defaultValue;
          }
        }
        setFormValues(defaults);
        setValidationErrors({});

        // Track form started (once per country selection)
        if (!formStartedRef.current) {
          formStartedRef.current = true;
          track(EXPERT_PAYOUT_EVENTS.PAYOUT_FORM_STARTED, { country_code: country });
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to fetch payout form schema';
        setSchemaError(message);
      } finally {
        setIsFetchingSchema(false);
      }
    },
    []
  );

  // ── Handlers ────────────────────────────────────────────────

  const handleCountryChange = useCallback(
    (code: string, curr: string) => {
      setCountryCode(code);
      setCurrency(curr);
      setState('form');
      formStartedRef.current = false;
      track(EXPERT_PAYOUT_EVENTS.PAYOUT_COUNTRY_SELECTED, { country_code: code });
      fetchSchema(code, curr, transferMethod, entityType);
    },
    [fetchSchema, transferMethod, entityType]
  );

  const handleRefreshField = useCallback(() => {
    fetchSchema(countryCode, currency, transferMethod, entityType, formValuesRef.current);
  }, [fetchSchema, countryCode, currency, transferMethod, entityType]);

  const handleEdit = useCallback(() => {
    setState('form');
    formStartedRef.current = false;
    if (countryCode) {
      fetchSchema(countryCode, currency, transferMethod, entityType, formValues);
    }
  }, [fetchSchema, countryCode, currency, transferMethod, entityType, formValues]);

  // ── Client-side validation ──────────────────────────────────

  function validateForm(): boolean {
    if (!schemaFields) return false;

    const errors: Record<string, string> = {};

    for (const field of schemaFields) {
      const value = formValues[field.path] ?? '';

      if (field.required && !value.trim()) {
        errors[field.path] = `${field.label} is required`;
        continue;
      }

      if (value && field.validation?.pattern) {
        try {
          if (field.validation.pattern.length > 200) continue;
          const regex = new RegExp(field.validation.pattern);
          if (!regex.test(value)) {
            errors[field.path] = `Invalid format for ${field.label}`;
          }
        } catch {
          // Skip invalid regex patterns
        }
      }
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  }

  // ── Submit ──────────────────────────────────────────────────

  async function handleSave(): Promise<void> {
    if (!validateForm()) {
      toast.error('Please fix the errors before saving.');
      return;
    }

    setIsSubmitting(true);

    try {
      const isUpdate = !!savedDetails;
      const result = await savePayoutDetailsAction({
        countryCode,
        currency,
        transferMethod,
        entityType,
        formValues,
      });

      if (result.success) {
        toast.success('Payout details saved successfully');

        const summary: PayoutDetailsSummary = {
          countryCode,
          currency,
          transferMethod,
          entityType,
          formValues: result.maskedFormValues ?? formValues,
          verifiedAt: null,
        };
        setSavedDetails(summary);
        setState('saved');

        if (isUpdate) {
          track(EXPERT_PAYOUT_EVENTS.PAYOUT_DETAILS_UPDATED, {
            country_code: countryCode,
            transfer_method: transferMethod,
          });
        } else {
          track(EXPERT_PAYOUT_EVENTS.PAYOUT_DETAILS_SAVED, {
            country_code: countryCode,
            transfer_method: transferMethod,
            is_initial_setup: true,
          });
        }
      } else {
        toast.error(result.error ?? 'Failed to save payout details');
      }
    } catch {
      toast.error('Failed to save payout details. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  // ── Render: Saved state ─────────────────────────────────────

  if (state === 'saved' && savedDetails) {
    return (
      <div>
        <motion.div variants={containerVariants} initial="hidden" animate="show">
          <motion.div variants={itemVariants} className="mb-8 flex items-center gap-3">
            <IconBadge icon={CreditCard} color="#4F6EF7" size={44} iconSize={22} />
            <div>
              <h1 className="text-foreground text-2xl font-semibold">Payout Details</h1>
              <p className="text-muted-foreground mt-0.5 text-sm leading-relaxed">
                Your bank details are saved and will be used for payout disbursements.
              </p>
            </div>
          </motion.div>
        </motion.div>

        <PayoutSavedState details={savedDetails} onEdit={handleEdit} />
      </div>
    );
  }

  // ── Render: Empty / Form state ──────────────────────────────

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="show">
      {/* Header — left-aligned, icon inline */}
      <motion.div variants={itemVariants} className="mb-8">
        <div className="flex items-center gap-3">
          <IconBadge icon={CreditCard} color="#4F6EF7" size={44} iconSize={22} />
          <h1 className="text-foreground text-2xl font-semibold">Payout Details</h1>
        </div>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          Where you want to receive your earnings. Balo admin disburses payouts manually after each
          payout cycle.
        </p>
      </motion.div>

      {/* Card with country + bank details sections */}
      <motion.div variants={itemVariants}>
        <Card className="px-6 pt-5 pb-6">
          {/* Country section — wrapped so Card's gap-6 doesn't split label from selector */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-amber-600" />
              <span className="text-xs font-semibold tracking-wider text-amber-600 uppercase">
                Country
              </span>
            </div>
            <PayoutCountrySelector
              value={countryCode}
              onCountryChange={handleCountryChange}
              disabled={isFetchingSchema}
            />
          </div>

          {/* Schema loading shimmer */}
          {isFetchingSchema && (
            <div className="space-y-4">
              <div className="bg-muted h-10 animate-pulse rounded-md" />
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-muted h-10 animate-pulse rounded-md" />
                <div className="bg-muted h-10 animate-pulse rounded-md" />
              </div>
              <div className="bg-muted h-10 animate-pulse rounded-md" />
            </div>
          )}

          {/* Schema error */}
          {schemaError && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <AlertCircle className="text-destructive h-8 w-8" />
              <p className="text-destructive text-sm">{schemaError}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchSchema(countryCode, currency, transferMethod, entityType)}
                className="gap-2"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Try again
              </Button>
            </div>
          )}

          {/* Bank details section — wrapped so Card's gap-6 doesn't split label from form */}
          {visibleFields && !isFetchingSchema && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-amber-600" />
                <span className="text-xs font-semibold tracking-wider text-amber-600 uppercase">
                  Bank Details
                </span>
              </div>
              <PayoutDynamicForm
                fields={visibleFields}
                formValues={formValues}
                onFormValuesChange={setFormValues}
                onRefreshField={handleRefreshField}
                validationErrors={validationErrors}
              />

              {/* Save button — right-aligned */}
              <div className="mt-4 flex justify-end">
                <Button
                  onClick={handleSave}
                  disabled={isSubmitting || !countryCode}
                  className="gap-2"
                >
                  <Check className="h-4 w-4" />
                  {isSubmitting ? 'Saving...' : 'Save Details'}
                </Button>
              </div>
            </div>
          )}
        </Card>
      </motion.div>

      {/* Trust badges */}
      <motion.div variants={itemVariants}>
        <div className="text-muted-foreground mt-4 flex items-start justify-between gap-4 text-xs">
          <div className="flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5 shrink-0" />
            <span>Bank details encrypted at rest</span>
          </div>
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            <span>Never shared with third parties</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5 shrink-0" />
            <span>Used only for payout disbursements</span>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
