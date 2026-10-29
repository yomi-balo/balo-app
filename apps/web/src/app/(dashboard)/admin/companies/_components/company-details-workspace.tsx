'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { toast } from 'sonner';
import { Building2, ChevronLeft, Lock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { InfoNote, SectionCard, SectionError } from '@/components/balo/section/section-states';
import { setCompanyIndustryAction } from '../_actions/set-company-industry';
import { setCompanyReviewNameHiddenAction } from '../_actions/set-company-review-name-hidden';
import type {
  CompanyDetailsActionResult,
  CompanyDetailsDto,
  IndustryOptionDto,
} from '../_lib/company-details-types';

const UNEXPECTED_ERROR = 'Something went wrong. Check the details before trying again.';

interface CompanyDetailsWorkspaceProps {
  company: CompanyDetailsDto;
  /** `null` means the industry list failed to load; the Industry row shows its error state. */
  industries: readonly IndustryOptionDto[] | null;
  canManage: boolean;
}

/**
 * The staff company page body: the company's industry and whether its name may show on reviews.
 * The only writes live in the two staff Server Actions; this component renders their results.
 */
export function CompanyDetailsWorkspace({
  company,
  industries,
  canManage,
}: Readonly<CompanyDetailsWorkspaceProps>): React.JSX.Element {
  const router = useRouter();
  const [industryId, setIndustryId] = useState<string | null>(company.industryId);
  const [nameShown, setNameShown] = useState(company.reviewNameHiddenAt === null);
  const [industryBusy, setIndustryBusy] = useState(false);
  const [nameBusy, setNameBusy] = useState(false);

  useEffect(() => setIndustryId(company.industryId), [company.industryId]);
  useEffect(() => setNameShown(company.reviewNameHiddenAt === null), [company.reviewNameHiddenAt]);

  const retry = useCallback((): void => router.refresh(), [router]);

  const settle = useCallback(
    (result: CompanyDetailsActionResult, onSuccess: () => void): void => {
      if (result.success) {
        onSuccess();
        toast.success(result.message);
      } else {
        toast.error(result.error);
      }
      router.refresh();
    },
    [router]
  );

  const changeIndustry = useCallback(
    async (next: string | null): Promise<void> => {
      setIndustryBusy(true);
      try {
        const result = await setCompanyIndustryAction({ companyId: company.id, industryId: next });
        settle(result, () => setIndustryId(next));
      } finally {
        setIndustryBusy(false);
      }
    },
    [company.id, settle]
  );

  const changeNameShown = useCallback(
    async (shown: boolean): Promise<void> => {
      setNameBusy(true);
      try {
        const result = await setCompanyReviewNameHiddenAction({
          companyId: company.id,
          hidden: !shown,
        });
        settle(result, () => setNameShown(shown));
      } finally {
        setNameBusy(false);
      }
    },
    [company.id, settle]
  );

  const reportUnexpected = useCallback((error: unknown): void => {
    Sentry.captureException(error);
    toast.error(UNEXPECTED_ERROR);
  }, []);

  const handleIndustryChange = useCallback(
    (value: string): void => {
      changeIndustry(value).catch(reportUnexpected);
    },
    [changeIndustry, reportUnexpected]
  );
  const handleClear = useCallback((): void => {
    changeIndustry(null).catch(reportUnexpected);
  }, [changeIndustry, reportUnexpected]);
  const handleNameShownChange = useCallback(
    (shown: boolean): void => {
      changeNameShown(shown).catch(reportUnexpected);
    },
    [changeNameShown, reportUnexpected]
  );

  const retiredCurrent =
    company.industryId !== null &&
    company.industryIsActive === false &&
    company.industryName !== null
      ? { id: company.industryId, name: company.industryName }
      : null;

  let industryControl: React.ReactNode;
  if (industries === null) {
    industryControl = <SectionError label="the industries" onRetry={retry} />;
  } else {
    industryControl = (
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={industryId ?? ''}
          onValueChange={handleIndustryChange}
          disabled={!canManage || industryBusy}
        >
          <SelectTrigger
            id="company-industry"
            aria-describedby="company-industry-help"
            aria-busy={industryBusy}
            className="min-h-[44px] w-full sm:w-72"
          >
            <SelectValue placeholder="Choose an industry" />
          </SelectTrigger>
          <SelectContent>
            {retiredCurrent !== null && (
              <SelectItem value={retiredCurrent.id} disabled>
                {`${retiredCurrent.name} (retired)`}
              </SelectItem>
            )}
            {industries.map((industry) => (
              <SelectItem key={industry.id} value={industry.id}>
                {industry.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {industryId !== null && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleClear}
            aria-label="Clear industry"
            aria-busy={industryBusy}
            disabled={!canManage || industryBusy}
            className="min-h-[44px]"
          >
            Clear
          </Button>
        )}
      </div>
    );
  }

  let footer: React.ReactNode = null;
  if (!canManage) {
    footer = (
      <InfoNote icon={Lock}>
        You can see these details but not change them. Changing them needs the Edit company details
        permission.
      </InfoNote>
    );
  } else if (company.isPersonal) {
    footer = (
      <InfoNote icon={Lock}>
        {`${company.name} is a personal workspace, so its name never appears on reviews.`}
      </InfoNote>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <Link
        href="/admin/lookup"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -ml-1 inline-flex min-h-[44px] w-fit items-center gap-1 rounded-lg text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <ChevronLeft className="size-4" aria-hidden="true" />
        Back to Lookup
      </Link>

      <header className="flex items-center gap-3.5">
        <span
          aria-hidden="true"
          className="bg-primary/10 text-primary flex size-11 flex-none items-center justify-center rounded-xl"
        >
          <Building2 className="size-5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-foreground text-[22px] font-semibold tracking-tight [overflow-wrap:anywhere]">
            {`${company.name} details`}
          </h1>
          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-[13px]">
            <Badge variant="outline">{company.isPersonal ? 'Personal workspace' : 'Company'}</Badge>
          </div>
        </div>
      </header>

      <SectionCard
        title="Industry and reviews"
        description="Both affect how the company appears on reviews. Each change is saved straight away and recorded on the Lookup timeline."
      >
        <div className="divide-border flex flex-col divide-y">
          <div className="flex flex-col gap-2 pb-5">
            <Label
              htmlFor={industries === null ? undefined : 'company-industry'}
              className="text-sm font-semibold"
            >
              Industry
            </Label>
            {industryControl}
            <p
              id="company-industry-help"
              className="text-muted-foreground text-[13px] leading-relaxed"
            >
              Shown on a review when the reviewer&apos;s company isn&apos;t.
            </p>
          </div>

          <div className="flex items-start justify-between gap-4 pt-5">
            <div className="min-w-0">
              <Label htmlFor="company-name-on-reviews" className="text-sm font-semibold">
                Show this company&apos;s name on reviews
              </Label>
              <p
                id="company-name-help"
                className="text-muted-foreground mt-1 text-[13px] leading-relaxed"
              >
                Reviewers who chose to show their company will appear with it again.
              </p>
            </div>
            <Switch
              id="company-name-on-reviews"
              aria-describedby="company-name-help"
              aria-busy={nameBusy}
              checked={nameShown}
              onCheckedChange={handleNameShownChange}
              disabled={!canManage || company.isPersonal || nameBusy}
            />
          </div>
        </div>
      </SectionCard>

      {footer}
    </div>
  );
}
