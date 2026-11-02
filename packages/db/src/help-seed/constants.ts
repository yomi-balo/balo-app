/**
 * Fixed values shared by the help-screenshot fixture and the Playwright runner. No imports on
 * purpose: `e2e/` loads this file by relative path, so it must not pull in the db client.
 * Every fixed id follows the `b1a10598-0000-4000-8000-…` pattern so `resetHelpFixture` removes
 * exactly the rows the seed added.
 */

export const HELP_IDS = {
  expertProfile: 'b1a10598-0000-4000-8000-000000000001',
  company: 'b1a10598-0000-4000-8000-000000000002',
  engagement: 'b1a10598-0000-4000-8000-000000000005',
  conversation: 'b1a10598-0000-4000-8000-000000000006',
  meeting: 'b1a10598-0000-4000-8000-000000000007',
  consultation: 'b1a10598-0000-4000-8000-000000000008',
  meetingContext: 'b1a10598-0000-4000-8000-000000000009',
  conversationContext: 'b1a10598-0000-4000-8000-00000000000a',
  calendarConnection: 'b1a10598-0000-4000-8000-00000000000b',
  payoutDetails: 'b1a10598-0000-4000-8000-00000000000c',
  subCalendar: 'b1a10598-0000-4000-8000-00000000000d',
  wallet: 'b1a10598-0000-4000-8000-00000000000e',
  ledgerPurchase: 'b1a10598-0000-4000-8000-00000000000f',
  guest: 'b1a10598-0000-4000-8000-000000000010',
  proposal: 'b1a10598-0000-4000-8000-000000000011',
  proposalOption1: 'b1a10598-0000-4000-8000-000000000012',
  proposalOption2: 'b1a10598-0000-4000-8000-000000000013',
  proposalOption3: 'b1a10598-0000-4000-8000-000000000014',
  autoClosedEngagement: 'b1a10598-0000-4000-8000-000000000015',
  autoClosedConversation: 'b1a10598-0000-4000-8000-000000000016',
  autoClosedConversationContext: 'b1a10598-0000-4000-8000-000000000017',
} as const;

export const HELP_AVAILABILITY_RULE_IDS: readonly string[] = [1, 2, 3, 4, 5].map(
  (day) => `b1a10598-0000-4000-8000-0000000001${String(day).padStart(2, '0')}`
);

/** The Dana row an earlier fixture created with a fixed id; reset still removes it. */
export const LEGACY_CLIENT_OWNER_ID = 'b1a10598-0000-4000-8000-000000000003';

export const HELP_EXPERT_EMAIL = 'onboarded-e2e@balo.test';

/** The address the `help-client` test-login persona resolves to. */
export const HELP_CLIENT_EMAIL = 'dana-help@balo.test';

/**
 * Raw invite token for the seeded email-invited guest. Local-fixture-only: it opens a meeting
 * that exists only in a throwaway local database, so it is never a real secret.
 */
export const HELP_GUEST_TOKEN = 'help-fixture-guest-invite-bal599-0123456789abcdef';

/** A fixed fixture id from a small number: `b1a10598-0000-4000-8000-` plus 12 hex digits. */
function helpId(n: number): string {
  return `b1a10598-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** Fixed ids from `first`, one per name, in order. */
function helpIdBlock<const K extends string>(
  first: number,
  names: readonly K[]
): Record<K, string> {
  return Object.fromEntries(names.map((name, index) => [name, helpId(first + index)])) as Record<
    K,
    string
  >;
}

/**
 * The conversation (`0x5…`) and context (`0x9…`) ids for one relationship id in the `0x1…` world
 * range: a relationship's thread is born with it (`requestExpertRelationshipsRepository.invite`),
 * so every seeded relationship gets one, and these ids follow from the relationship's.
 */
export function helpThreadIds(relationshipId: string): { conversation: string; context: string } {
  const tail = relationshipId.slice(-3);
  const head = relationshipId.slice(0, -4);
  return { conversation: `${head}5${tail}`, context: `${head}9${tail}` };
}

/**
 * Ids for the rows the project-world states add (`world.ts`). Every one is inserted by a state
 * and removed by `deleteHelpWorld`, which `restoreBase` and `resetHelpFixture` both call, so the
 * base fixture never carries them. Ranges: people `0x10…`, fixed-price project `0x11…`, T&M
 * project `0x12…`, request world `0x13…`, dashboards `0x14…`, agencies `0x15…`, case files
 * `0x16…`, client-guide fixed-price project `0x17…`.
 */
export const HELP_WORLD_IDS = {
  people: helpIdBlock(0x1001, [
    'marcusUser',
    'aishaUser',
    'tomUser',
    'lenaUser',
    'marcusProfile',
    'aishaProfile',
    'tomProfile',
    'lenaProfile',
    'kestrel',
    'brightwater',
    'larkspur',
    'cloudPeak',
    'summitRidge',
    'priyaCloudPeak',
    'marcusCloudPeak',
    'aishaCloudPeak',
    'tomCloudPeak',
    'lenaSummitRidge',
    'priyaSummitRidge',
  ]),
  fixed: helpIdBlock(0x1101, [
    'request',
    'relationship',
    'eoi',
    'proposal',
    'proposalMilestone1',
    'proposalMilestone2',
    'proposalMilestone3',
    'installment1',
    'installment2',
    'engagement',
    'milestone1',
    'milestone2',
    'milestone3',
    'contentEditAudit',
    'answeredOrder',
    'round',
    'roundTag',
  ]),
  tm: helpIdBlock(0x1201, [
    'request',
    'relationship',
    'eoi',
    'engagement',
    'milestone1',
    'milestone2',
    'milestone3',
    'addedMilestone',
    'entry1',
    'entry2',
    'entry3',
    'entry4',
    'entry5',
    'entry6',
    'entry7',
    'changeOrder',
    'lineEdit',
    'lineAdd',
  ]),
  requests: helpIdBlock(0x1301, [
    'direct',
    'directRelationship',
    'directEoi',
    'drafted',
    'draftedRelationship',
    'draftedEoi',
    'draftedGeneration',
    'fixed',
    'fixedRelationship',
    'fixedEoi',
    'fixedProposal',
    'fixedMilestone1',
    'fixedMilestone2',
    'fixedMilestone3',
    'fixedInstallment1',
    'fixedInstallment2',
    'fixedInstallment3',
    'tm',
    'tmRelationship',
    'tmEoi',
    'tmProposal',
    'tmMilestone1',
    'tmMilestone2',
    'tmMilestone3',
    'revise',
    'reviseRelationship',
    'reviseEoi',
    'reviseProposal',
    'reviseMilestone1',
    'reviseMilestone2',
    'reviseInstallment1',
    'reviseInstallment2',
    'reviseChangeRequest',
    'matched',
    'matchedPriya',
    'matchedMarcus',
    'matchedAisha',
    'matchedPriyaEoi',
    'matchedMarcusEoi',
    'matchedAishaEoi',
    'priyaMessage',
    'danaShareMessage',
    'fileOverview',
    'fileMatrix',
    'fileFlow',
    'fileQuestions',
    'grantMatrixPriya',
    'grantMatrixMarcus',
    'grantFlowPriya',
  ]),
  dashboards: helpIdBlock(0x1401, [
    'invitation',
    'invitationRelationship',
    'invitationProduct1',
    'invitationProduct2',
    'invitationTag',
    'interest',
    'interestRelationship',
    'interestEoi',
    'proposalRequested',
    'proposalRequestedRelationship',
    'proposalRequestedEoi',
    'awaitingKickoff',
    'awaitingKickoffRelationship',
    'awaitingKickoffEoi',
    'migration',
    'migrationRelationship',
    'migrationEoi',
    'migrationEngagement',
    'migrationMilestone1',
    'migrationMilestone2',
    'migrationMilestone3',
    'migrationMilestone4',
    'referrals',
    'referralsRelationship',
    'referralsEoi',
    'referralsEngagement',
    'referralsMilestone1',
    'referralsMilestone2',
    'referralsMilestone3',
    'actionItemOverdue',
    'actionItemOpen',
    'caseMessage',
    'exploratory',
    'approval',
    'approvalRelationship',
    'approvalEoi',
    'approvalProposal',
    'approvalMilestone1',
    'approvalMilestone2',
    'approvalMilestone3',
    'approvalInstallment1',
    'approvalInstallment2',
    'waitingOnBalo',
  ]),
  agency: helpIdBlock(0x1501, [
    'routingRequest',
    'migrationRequest',
    'dashboardsRequest',
    'cpqRequest',
    'portalRequest',
    'flowAuditRequest',
    'journeyRequest',
    'fieldServiceRequest',
    'intakeRequest',
    'routing',
    'migration',
    'dashboards',
    'cpq',
    'portal',
    'flowAudit',
    'journey',
    'fieldService',
    'intake',
    'notificationChanges',
    'notificationEstimate',
    'notificationCancelled',
  ]),
  caseFiles: helpIdBlock(0x1601, ['errorLog', 'screenshot', 'export', 'mapping']),
  /**
   * The fixed-price project only client-side guides show. It never shares a screen with the
   * expert-side "Sales Cloud rollout", so no two help images give the same project's price with
   * and without Balo's markup.
   */
  territory: helpIdBlock(0x1701, [
    'request',
    'relationship',
    'eoi',
    'proposal',
    'proposalMilestone1',
    'proposalMilestone2',
    'proposalMilestone3',
    'installment1',
    'installment2',
    'engagement',
    'milestone1',
    'milestone2',
    'milestone3',
    'answeredOrder',
    'sentOrder',
    'sentLineAdd',
    'sentLineEdit',
    'sentLineRemove',
  ]),
} as const;

/** First id of the agency world's milestone block; `world.ts` numbers milestones from here. */
export const HELP_AGENCY_MILESTONE_BASE = 0x1581;

/** The fixed id for the agency world's `n`th milestone (0-based). */
export function helpAgencyMilestoneId(n: number): string {
  return helpId(HELP_AGENCY_MILESTONE_BASE + n);
}

export const HELP_FIXTURE_STATES = [
  'available',
  'paused',
  'proposal',
  'held',
  'calendar-pending',
  'overnight',
  'setup-incomplete',
  'rejected',
  'client-member',
  'auto-closed',
  'projects',
  'change-requested',
  'change-draft',
  'change-sent',
  'change-approved',
  'change-round',
  'changes-made',
  'requests',
  'dashboards',
  'agency',
  'agency-multi',
  'case-files',
] as const;

export type HelpFixtureState = (typeof HELP_FIXTURE_STATES)[number];
