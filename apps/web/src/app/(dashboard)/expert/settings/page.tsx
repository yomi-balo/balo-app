import { getChecklistStatus } from '@/lib/actions/expert-checklist';
import { SettingsTabs } from './_components/settings-tabs';
import { SetupContextBar } from './_components/setup-context-bar';
import { CHECKLIST_ITEMS } from '@/lib/constants/expert-checklist';
import { log } from '@/lib/logging';
import { getSession } from '@/lib/auth/session';
import {
  payoutsRepository,
  expertsRepository,
  referenceDataRepository,
  type BeneficiaryStatus,
  type ProfileSettingsData,
  type CertificationsByCategory,
} from '@balo/db';
import type { PayoutDetailsSummary } from './_components/payouts-tab';

const VALID_TABS = new Set<string>([
  'profile',
  'expertise',
  'workHistory',
  'certifications',
  'rate',
  'schedule',
  'payouts',
]);
const VALID_SETUP_KEYS = new Set<string>(CHECKLIST_ITEMS.map((item) => item.key));

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

  // Fetch initial payout details for the expert
  let initialPayoutDetails: PayoutDetailsSummary | null = null;

  // Fetch profile data and reference data for the profile/expertise/work-history/certifications tabs
  let profileData: ProfileSettingsData | null = null;
  let allLanguages: Array<{ id: string; name: string; code: string; flagEmoji: string | null }> =
    [];
  let allIndustries: Array<{ id: string; name: string }> = [];
  let certCategories: CertificationsByCategory[] | null = null;

  try {
    const session = await getSession();
    if (session?.user?.expertProfileId) {
      const [payoutDetails, profile, languages, industries, certs] = await Promise.all([
        payoutsRepository.findByExpertProfileId(session.user.expertProfileId),
        expertsRepository.findProfileForSettings(session.user.expertProfileId),
        referenceDataRepository.getLanguages(),
        referenceDataRepository.getIndustries(),
        session.user.verticalId
          ? referenceDataRepository.getCertificationsByVertical(session.user.verticalId)
          : Promise.resolve([]),
      ]);

      if (payoutDetails) {
        initialPayoutDetails = {
          countryCode: payoutDetails.countryCode,
          currency: payoutDetails.currency,
          transferMethod: payoutDetails.transferMethod,
          entityType: payoutDetails.entityType,
          tradingName: payoutDetails.tradingName ?? null,
          formValues: payoutDetails.formValues as Record<string, string>,
          verifiedAt: payoutDetails.verifiedAt?.toISOString() ?? null,
          beneficiaryStatus: (payoutDetails.beneficiaryStatus as BeneficiaryStatus) ?? null,
        };
      }

      if (profile) {
        profileData = profile;
      }

      allLanguages = languages.map((l) => ({
        id: l.id,
        name: l.name,
        code: l.code,
        flagEmoji: l.flagEmoji,
      }));

      allIndustries = industries.map((i) => ({
        id: i.id,
        name: i.name,
      }));

      certCategories = certs;
    }
  } catch (error) {
    log.warn('Failed to fetch settings data', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return (
    <div>
      {setupStep && checklistStatus && !checklistStatus.allComplete && (
        <SetupContextBar activeSetupStep={setupStep} checklistStatus={checklistStatus} />
      )}
      <SettingsTabs
        defaultTab={activeTab}
        setupStep={setupStep}
        initialRateCents={initialRateCents}
        initialPayoutDetails={initialPayoutDetails}
        profileData={profileData}
        referenceData={
          allLanguages.length > 0 || allIndustries.length > 0
            ? { languages: allLanguages, industries: allIndustries }
            : null
        }
        certCategories={certCategories}
      />
    </div>
  );
}
