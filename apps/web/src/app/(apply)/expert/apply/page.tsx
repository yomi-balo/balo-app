import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { loadReferenceData } from '@/lib/expert-apply/reference-data';
import { platformSettingsRepository } from '@balo/db';
import { reapplyAvailableAt, isReapplyCooldownActive } from '@balo/shared/experts';
import { formatLongUtc } from '@/lib/format/utc-date';
import { loadDraftAction } from './_actions/load-draft';
import { ExpertApplicationWizard } from './_components/expert-application-wizard';
import { DeclinedApplicationPanel } from './_components/declined-application-panel';

export const metadata: Metadata = {
  title: 'Apply as Expert | Balo',
};

export default async function ExpertApplyPage(): Promise<React.JSX.Element> {
  const user = await getCurrentUser();

  // ── Anonymous preview (BAL-502 §22). Public taxonomy only: no draft read, no
  // user. The auth wall sits at SUBMIT (step-terms), not here. Every `user.*`
  // access below lives inside the truthy branch, so this render can never
  // dereference a null user.
  if (!user) {
    const referenceData = await loadReferenceData();
    return <ExpertApplicationWizard draft={null} referenceData={referenceData} user={null} />;
  }

  if (!user.onboardingCompleted) redirect('/onboarding');

  const { draft, referenceData } = await loadDraftAction();

  // Already submitted -> success page
  if (
    draft?.profile.applicationStatus === 'submitted' ||
    draft?.profile.applicationStatus === 'under_review'
  ) {
    redirect('/expert/apply/success');
  }

  // Already approved -> dashboard
  if (draft?.profile.applicationStatus === 'approved') {
    redirect('/dashboard');
  }

  /*
    BAL-557 — THE DECLINED PANEL REPLACES THE WIZARD WHILE `rejected`.

    ⚠⚠ RE-APPLYING IS NOW SUPPORTED, THROUGH ONE EXPLICIT ACTION. This used to be a FALL-THROUGH
    — nothing redirected a declined applicant away, so `'rejected'` rendered the wizard prefilled
    with their own answers, and every write refused (`DECLINED_APPLICATION_ERROR`). BAL-549's
    fix-round F1 stripped the decision columns off `draft` as defence in depth for that
    fall-through. BAL-557 removes the fall-through itself: `'rejected'` no longer reaches the
    wizard at all, so there is nothing left to strip. `DeclinedApplicationPanel` receives only a
    pre-formatted date string (or `null`) and a boolean — never `declineReason`, `decidedAt`,
    `decidedByUserId` or `declineNote`. The cooldown (`expert_reapply_cooldown_days`) is read at
    CALL TIME so the shown date always matches what `reopenApplication` would enforce.

    Start a new application via `startNewApplicationAction` (`rejected → draft`); the page then
    re-renders the wizard, prefilled with the applicant's own answers.
  */
  if (draft?.profile.applicationStatus === 'rejected') {
    const cooldown = await platformSettingsRepository.get('expert_reapply_cooldown_days');
    const now = new Date();
    const availableAt = reapplyAvailableAt(draft.profile.decidedAt, cooldown.value);
    return (
      <DeclinedApplicationPanel
        reapplyAvailableOn={availableAt === null ? null : formatLongUtc(availableAt)}
        canStartNow={!isReapplyCooldownActive(draft.profile.decidedAt, cooldown.value, now)}
      />
    );
  }

  return (
    // FIX round (smaller item) — `{ id }` only, not `{ id, email }`: nothing under
    // `_components/` reads either field off `user` (only its nullness matters, for
    // `isAnonymous`), so the visitor's own email address is dead payload here.
    <ExpertApplicationWizard
      draft={draft ?? null}
      referenceData={referenceData}
      user={{ id: user.id }}
    />
  );
}
