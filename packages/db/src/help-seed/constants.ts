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
] as const;

export type HelpFixtureState = (typeof HELP_FIXTURE_STATES)[number];
