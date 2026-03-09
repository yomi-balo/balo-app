'use client';

import { motion } from 'motion/react';
import { CheckCircle2, Clock, AlertCircle, Pencil, Lock, ShieldCheck, Zap } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { getCountryByCode } from '@/lib/constants/countries';
import { COMPANY_LABEL_OVERRIDES } from '../_constants/payout-labels';
import type { PayoutDetailsSummary } from '@/app/(dashboard)/expert/settings/_components/payouts-tab';

interface PayoutSavedStateProps {
  details: PayoutDetailsSummary;
  onEdit: () => void;
}

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.06 },
  },
} as const;

const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.25, ease: 'easeOut' as const } },
};

export function PayoutSavedState({ details, onEdit }: PayoutSavedStateProps): React.JSX.Element {
  const country = getCountryByCode(details.countryCode);

  // Metadata / auto-populated paths that should not appear in the saved-state display
  const hiddenPaths = new Set([
    'beneficiary.entity_type',
    'beneficiary.bank_details.bank_country_code',
    'beneficiary.bank_details.account_currency',
    'beneficiary.bank_details.local_clearing_system',
    'beneficiary.bank_details.transfer_method',
    'beneficiary.bank_details.account_routing_type1',
    'transfer_method',
    'beneficiary.address.country_or_region',
    'beneficiary.address.country_code',
  ]);

  // Build display fields from formValues (already masked), with label overrides
  const displayFields = Object.entries(details.formValues)
    .filter(([path]) => !hiddenPaths.has(path))
    .map(([path, value]) => {
      const overrideLabel = COMPANY_LABEL_OVERRIDES[path];
      const lastSegment = path.split('.').pop() ?? path;
      const label =
        overrideLabel ?? lastSegment.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
      return { path, label, value };
    });

  // Check if trading name matches account holder name for badge display
  const accountHolderName = details.formValues['beneficiary.bank_details.account_name'] ?? '';
  const tradingNameMatchesAccount =
    !!details.tradingName && details.tradingName === accountHolderName && accountHolderName !== '';

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="show">
      {/* Country and method badges */}
      <motion.div variants={itemVariants} className="mb-4 flex flex-wrap items-center gap-2">
        {country && (
          <Badge variant="outline" className="gap-1.5 px-3 py-1 text-sm">
            <span>{country.flag}</span>
            {country.name}
          </Badge>
        )}
        <Badge variant="secondary" className="px-3 py-1 text-sm">
          {details.transferMethod}
        </Badge>
        <Badge variant="secondary" className="px-3 py-1 text-sm">
          {details.currency}
        </Badge>
        {details.entityType && (
          <Badge variant="secondary" className="px-3 py-1 text-sm capitalize">
            {details.entityType.toLowerCase()}
          </Badge>
        )}
        {details.beneficiaryStatus === 'verified' && (
          <Badge className="gap-1 bg-emerald-600 px-3 py-1 text-sm text-white hover:bg-emerald-700">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Verified
          </Badge>
        )}
        {details.beneficiaryStatus === 'pending_verification' && (
          <Badge className="gap-1 bg-amber-500 px-3 py-1 text-sm text-white hover:bg-amber-600">
            <Clock className="h-3.5 w-3.5" />
            Verifying
          </Badge>
        )}
      </motion.div>

      {/* Saved field values */}
      <motion.div variants={itemVariants}>
        <Card className="p-6">
          {details.tradingName && (
            <div className="mb-4">
              <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                Business Name
              </p>
              <div className="mt-0.5 flex items-center gap-2">
                <p className="text-foreground font-mono text-sm">{details.tradingName}</p>
                {tradingNameMatchesAccount && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                    Same as account
                  </Badge>
                )}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {displayFields.map((field) => (
              <div key={field.path}>
                <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                  {field.label}
                </p>
                <p className="text-foreground mt-0.5 font-mono text-sm">{field.value}</p>
              </div>
            ))}
          </div>

          <Separator className="my-5" />

          <div className="flex items-center justify-between">
            <Button variant="outline" onClick={onEdit} className="gap-2">
              <Pencil className="h-4 w-4" />
              Edit payout details
            </Button>
          </div>

          {details.beneficiaryStatus === 'pending_verification' && (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>
                We&apos;re verifying your bank details — this usually takes a few minutes.
              </span>
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
