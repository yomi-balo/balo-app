import { getChecklistStatus } from '@/lib/actions/expert-checklist';
import { SettingsTabs, type AgencyDomainsTabData } from './_components/settings-tabs';
import { SetupContextBar } from './_components/setup-context-bar';
import { CHECKLIST_ITEMS } from '@/lib/constants/expert-checklist';
import { log } from '@/lib/logging';
import { getSession } from '@/lib/auth/session';
import {
  payoutsRepository,
  expertsRepository,
  referenceDataRepository,
  usersRepository,
  type BeneficiaryStatus,
  type ProfileSettingsData,
  type CertificationsByCategory,
} from '@balo/db';
import { resolveAgencyDomainsTab } from './_lib/resolve-agency-domains-tab';
import type { PayoutDetailsSummary } from './_components/payouts-tab';

const VALID_TABS = new Set<string>([
  'profile',
  'expertise',
  'workHistory',
  'certifications',
  'rate',
  'schedule',
  'payouts',
  'domains',
]);
const VALID_SETUP_KEYS = new Set<string>(CHECKLIST_ITEMS.map((item) => item.key));

interface ExpertSettingsData {
  accessToken: string;
  initialPayoutDetails: PayoutDetailsSummary | null;
  profileData: ProfileSettingsData | null;
  languages: Array<{ id: string; name: string; code: string; flagEmoji: string | null }>;
  industries: Array<{ id: string; name: string }>;
  certCategories: CertificationsByCategory[] | null;
  phone: string | null;
  phoneVerifiedAt: string | null;
  canManageAgency: boolean;
  agencyDomains: AgencyDomainsTabData | null;
}

const EMPTY_SETTINGS_DATA: ExpertSettingsData = {
  accessToken: '',
  initialPayoutDetails: null,
  profileData: null,
  languages: [],
  industries: [],
  certCategories: null,
  phone: null,
  phoneVerifiedAt: null,
  canManageAgency: false,
  agencyDomains: null,
};

/**
 * Load everything the settings tabs need (payouts, profile + reference data, phone,
 * and the BAL-347 agency Domains tab). Extracted from the page so the component stays
 * flat; returns defaults for a session without an expert profile.
 */
async function loadExpertSettingsData(): Promise<ExpertSettingsData> {
  const session = await getSession();
  const accessToken = session?.accessToken ?? '';
  const user = session?.user;
  if (!user?.expertProfileId) {
    return { ...EMPTY_SETTINGS_DATA, accessToken };
  }

  const [payoutDetails, profile, languages, industries, certs, userData] = await Promise.all([
    payoutsRepository.findByExpertProfileId(user.expertProfileId),
    expertsRepository.findProfileForSettings(user.expertProfileId),
    referenceDataRepository.getLanguages(),
    referenceDataRepository.getIndustries(),
    user.verticalId
      ? referenceDataRepository.getCertificationsByVertical(user.verticalId)
      : Promise.resolve([]),
    usersRepository.findById(user.id),
  ]);

  const agencyResult = await resolveAgencyDomainsTab(user, profile?.agencyId ?? null);

  return {
    accessToken,
    initialPayoutDetails: payoutDetails
      ? {
          countryCode: payoutDetails.countryCode,
          currency: payoutDetails.currency,
          transferMethod: payoutDetails.transferMethod,
          entityType: payoutDetails.entityType,
          tradingName: payoutDetails.tradingName ?? null,
          formValues: payoutDetails.formValues as Record<string, string>,
          verifiedAt: payoutDetails.verifiedAt?.toISOString() ?? null,
          beneficiaryStatus: (payoutDetails.beneficiaryStatus as BeneficiaryStatus) ?? null,
        }
      : null,
    profileData: profile ?? null,
    languages: languages.map((l) => ({
      id: l.id,
      name: l.name,
      code: l.code,
      flagEmoji: l.flagEmoji,
    })),
    industries: industries.map((i) => ({ id: i.id, name: i.name })),
    certCategories: certs,
    phone: userData?.phone ?? null,
    phoneVerifiedAt: userData?.phoneVerifiedAt?.toISOString() ?? null,
    canManageAgency: agencyResult.canManageAgency,
    agencyDomains: agencyResult.agencyDomains,
  };
}

interface ExpertSettingsPageProps {
  searchParams: Promise<{ tab?: string; setup?: string }>;
}

export default async function ExpertSettingsPage({
  searchParams,
}: ExpertSettingsPageProps): Promise<React.JSX.Element> {
  const params = await searchParams;
  const activeTab = VALID_TABS.has(params.tab ?? '') ? params.tab! : 'profile';
  const setupStep = params.setup && VALID_SETUP_KEYS.has(params.setup) ? params.setup : null;

  let checklistStatus = null;
  try {
    checklistStatus = await getChecklistStatus();
  } catch (error) {
    log.warn('Failed to fetch checklist status for settings', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const initialRateCents = checklistStatus?.rateCents ?? null;

  let data = EMPTY_SETTINGS_DATA;
  try {
    data = await loadExpertSettingsData();
  } catch (error) {
    log.warn('Failed to fetch settings data', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // A non-admin can't force the Domains tab via the URL — coerce it back to profile.
  const resolvedTab = activeTab === 'domains' && !data.canManageAgency ? 'profile' : activeTab;

  const hasReferenceData = data.languages.length > 0 || data.industries.length > 0;

  return (
    <div>
      {setupStep && checklistStatus && !checklistStatus.allComplete && (
        <SetupContextBar activeSetupStep={setupStep} checklistStatus={checklistStatus} />
      )}
      <SettingsTabs
        defaultTab={resolvedTab}
        setupStep={setupStep}
        initialRateCents={initialRateCents}
        initialPayoutDetails={data.initialPayoutDetails}
        profileData={data.profileData}
        referenceData={
          hasReferenceData ? { languages: data.languages, industries: data.industries } : null
        }
        certCategories={data.certCategories}
        initialPhone={data.phone}
        phoneVerifiedAt={data.phoneVerifiedAt}
        accessToken={data.accessToken}
        canManageAgency={data.canManageAgency}
        agencyDomains={data.agencyDomains}
      />
    </div>
  );
}
