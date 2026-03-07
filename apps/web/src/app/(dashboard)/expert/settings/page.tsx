import { getChecklistStatus } from '@/lib/actions/expert-checklist';
import { SettingsTabs } from './_components/settings-tabs';
import { SetupContextBar } from './_components/setup-context-bar';
import { CHECKLIST_ITEMS } from '@/lib/constants/expert-checklist';
import { log } from '@/lib/logging';

const VALID_TABS = new Set<string>(['profile', 'expertise', 'rate', 'schedule', 'payouts']);
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

  return (
    <div>
      {setupStep && checklistStatus && !checklistStatus.allComplete && (
        <SetupContextBar activeSetupStep={setupStep} checklistStatus={checklistStatus} />
      )}
      <SettingsTabs defaultTab={activeTab} setupStep={setupStep} />
    </div>
  );
}
