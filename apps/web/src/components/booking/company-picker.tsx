'use client';

import { Building2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import type { EligibleCompany } from '@balo/shared/credit';

export interface CompanyPickerProps {
  companies: readonly EligibleCompany[];
  value: string | null;
  onChange: (companyId: string) => void;
}

/**
 * BAL-400 §4 — rendered only for new-case + >1 eligible company (the caller decides that).
 * Names only, no default selection (D1a: a silent default is exactly the guess the API
 * contract refuses to make server-side — the UI must not make it either).
 */
export function CompanyPicker({
  companies,
  value,
  onChange,
}: Readonly<CompanyPickerProps>): React.JSX.Element {
  return (
    <div className="space-y-2">
      <label htmlFor="booking-company-picker" className="text-foreground text-sm font-semibold">
        Bill this session to <span className="text-destructive">*</span>
      </label>
      <Select value={value ?? undefined} onValueChange={onChange}>
        <SelectTrigger id="booking-company-picker" className="w-full">
          <SelectValue placeholder="Choose an account" />
        </SelectTrigger>
        <SelectContent>
          {companies.map((company) => (
            <SelectItem key={company.id} value={company.id}>
              <Building2 className="text-muted-foreground h-3.5 w-3.5" aria-hidden="true" />
              {company.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-xs leading-relaxed">
        Consultations are billed to a company account, not to you personally.
      </p>
    </div>
  );
}

/** The fail-closed retry banner shown when the company-eligibility read fails (D1a). */
export function CompanyPickerErrorBanner({
  onRetry,
}: Readonly<{ onRetry: () => void }>): React.JSX.Element {
  return (
    <div className="border-destructive/20 bg-destructive/5 flex items-center justify-between gap-3 rounded-lg border p-3">
      <p className="text-destructive text-xs font-medium">
        We couldn&apos;t check your company details.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
