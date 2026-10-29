import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { companiesRepository, referenceDataRepository } from '@balo/db';
import { EntityCrumb } from '@/components/layout/breadcrumb-context';
import { getCurrentUser } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { log } from '@/lib/logging';
import { CompanyDetailsWorkspace } from '../_components/company-details-workspace';
import type { IndustryOptionDto } from '../_lib/company-details-types';

/**
 * The Balo-staff details page for one company: its industry and whether its name may show on
 * reviews.
 *
 * Reachability is gated on `VIEW_PLATFORM_ADMIN` (same as Lookup, which links here); anyone else
 * gets a 404. The controls are disabled for anyone without `MANAGE_COMPANY_DETAILS`, and every
 * Server Action re-checks that capability against the live row, so this render-time read is
 * cosmetic.
 *
 * The browser receives a projected `CompanyDetailsDto` (ISO dates), never the repository row.
 */

export const metadata: Metadata = {
  title: 'Company details — Balo',
  robots: { index: false, follow: false },
};

interface AdminCompanyDetailsPageProps {
  params: Promise<{ companyId: string }>;
}

async function loadIndustries(companyId: string): Promise<IndustryOptionDto[] | null> {
  try {
    const rows = await referenceDataRepository.getIndustries();
    return rows.map((row) => ({ id: row.id, name: row.name }));
  } catch (error) {
    log.error('Failed to load industries for staff company details', {
      companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}

export default async function AdminCompanyDetailsPage({
  params,
}: Readonly<AdminCompanyDetailsPageProps>): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }
  if (!hasPlatformCapability(user, PLATFORM_CAPABILITIES.VIEW_PLATFORM_ADMIN)) {
    notFound();
  }

  const { companyId: rawCompanyId } = await params;
  const parsedId = z.uuid().safeParse(rawCompanyId);
  if (!parsedId.success) {
    notFound();
  }

  const company = await companiesRepository.findAdminDetailsById(parsedId.data);
  if (company === undefined) {
    notFound();
  }

  const industries = await loadIndustries(company.id);
  const canManage = hasPlatformCapability(user, PLATFORM_CAPABILITIES.MANAGE_COMPANY_DETAILS);

  return (
    <>
      <EntityCrumb label={`${company.name} details`} />
      <CompanyDetailsWorkspace
        company={{
          id: company.id,
          name: company.name,
          isPersonal: company.isPersonal,
          industryId: company.industryId,
          industryName: company.industryName,
          industryIsActive: company.industryIsActive,
          reviewNameHiddenAt: company.reviewNameHiddenAt?.toISOString() ?? null,
        }}
        industries={industries}
        canManage={canManage}
      />
    </>
  );
}
