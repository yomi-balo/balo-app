import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../client';
import {
  availabilityRules,
  calendarConnections,
  calendarSubCalendars,
  caseEngagements,
  companies,
  companyMembers,
  consultations,
  conversationContexts,
  conversations,
  creditHolds,
  creditLedger,
  creditReceivables,
  creditSessions,
  creditWallets,
  engagements,
  expertPayoutDetails,
  expertPayoutRecords,
  expertProfiles,
  meetingContexts,
  meetingGuests,
  meetings,
  rescheduleProposalOptions,
  rescheduleProposals,
  users,
  verticals,
} from '../schema';
import {
  HELP_AVAILABILITY_RULE_IDS,
  HELP_CLIENT_EMAIL,
  HELP_EXPERT_EMAIL,
  HELP_GUEST_TOKEN,
  HELP_IDS,
  LEGACY_CLIENT_OWNER_ID,
  type HelpFixtureState,
} from './constants';

export { HELP_CLIENT_EMAIL, HELP_EXPERT_EMAIL };

/**
 * Help-centre screenshot fixture. Gives the shared `onboarded-e2e@balo.test` user an approved
 * expert profile (Priya Raman), and the `dana-help@balo.test` test-login user the identity of
 * Dana Whitfield, owner of one client company (Northwind Industrial) that holds a funded wallet
 * with a live card mandate and a booked consultation in the coming week. Every row the fixture
 * owns has a fixed id (see `constants.ts`), so `resetHelpFixture` removes exactly what
 * `seedHelpFixture` added; the two test-login users are handed back, never deleted.
 *
 * Rows are written with raw drizzle on purpose (the `seed.ts` exception): the test factories
 * randomise, and a screenshot fixture must be byte-stable.
 */

type HelpExecutor = Pick<Database, 'insert' | 'update' | 'delete' | 'select'>;

/** Name test-login gives a user it creates; `reset` restores this. */
const TEST_LOGIN_FIRST_NAME = 'E2E';
const TEST_LOGIN_LAST_NAME = 'Test';

const IDS = HELP_IDS;

/** A repo-served asset, so the avatar needs no new public file and renders identically each run. */
const HELP_AVATAR_URL = '/brand/balo-icon.png';

const FIXED_DECISION_TIME = new Date('2026-01-05T00:00:00Z');
const CONSULTATION_START_HOUR_UTC = 14;
const MINUTES_PER_HOUR = 60;
const MS_PER_DAY = 86_400_000;
const WALLET_BALANCE_MINOR = 124_000;
const CONSULTATION_MINUTES = 60;
const MS_PER_MINUTE = 60_000;

/** Parses `YYYY-MM-DD` and returns its UTC midnight; throws unless it is a real Monday. */
export function parseMondayAnchor(anchor: string | undefined): Date {
  if (anchor === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) {
    throw new Error('--anchor=YYYY-MM-DD is required (a Monday)');
  }
  const date = new Date(`${anchor}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== anchor) {
    throw new Error(`--anchor ${anchor} is not a valid calendar date`);
  }
  if (date.getUTCDay() !== 1) {
    throw new Error(`--anchor ${anchor} is not a Monday`);
  }
  return date;
}

/** Deletes the money rows a live API may have written against the fixture wallet. */
async function deleteWalletChildren(db: HelpExecutor): Promise<void> {
  await db.delete(expertPayoutRecords).where(eq(expertPayoutRecords.companyId, IDS.company));
  await db.delete(creditReceivables).where(eq(creditReceivables.walletId, IDS.wallet));
  // credit_holds.session_id and credit_sessions.hold_id are mutual RESTRICT FKs: break the cycle.
  await db.update(creditHolds).set({ sessionId: null }).where(eq(creditHolds.walletId, IDS.wallet));
  await db.delete(creditLedger).where(eq(creditLedger.walletId, IDS.wallet));
  await db.delete(creditSessions).where(eq(creditSessions.walletId, IDS.wallet));
  await db.delete(creditHolds).where(eq(creditHolds.walletId, IDS.wallet));
}

export async function resetHelpFixture(db: HelpExecutor): Promise<void> {
  // FK-safe order; every delete is by fixture id or by a fixture-owned parent key (the wallet,
  // the company). Meetings cascade to contexts + consultations;
  // engagements to case rows; the expert profile to connection, sub-calendars and payout details.
  await db
    .delete(rescheduleProposalOptions)
    .where(
      inArray(rescheduleProposalOptions.id, [
        IDS.proposalOption1,
        IDS.proposalOption2,
        IDS.proposalOption3,
      ])
    );
  await db.delete(rescheduleProposals).where(eq(rescheduleProposals.id, IDS.proposal));
  await db.delete(meetingGuests).where(eq(meetingGuests.id, IDS.guest));
  await deleteWalletChildren(db);
  await db.delete(meetings).where(eq(meetings.id, IDS.meeting));
  await db.delete(conversations).where(eq(conversations.id, IDS.conversation));
  await deleteAutoClosedCase(db);
  await db.delete(engagements).where(eq(engagements.id, IDS.engagement));
  await db
    .delete(availabilityRules)
    .where(eq(availabilityRules.expertProfileId, IDS.expertProfile));
  await db.delete(expertProfiles).where(eq(expertProfiles.id, IDS.expertProfile));
  // Dana stays (test-login owns the row); release her active workspace before the company goes.
  await handBackTestLoginUser(db, HELP_CLIENT_EMAIL);
  await db.delete(companyMembers).where(eq(companyMembers.companyId, IDS.company));
  await db.delete(companies).where(eq(companies.id, IDS.company));
  await db.delete(users).where(eq(users.id, LEGACY_CLIENT_OWNER_ID));
  await handBackTestLoginUser(db, HELP_EXPERT_EMAIL);
}

/** Throws unless `email` is absent or a plain `user` row with no capability override. */
async function assertPlainUserOrAbsent(db: HelpExecutor, email: string): Promise<void> {
  const [existing] = await db
    .select({
      platformRole: users.platformRole,
      platformCapabilities: users.platformCapabilities,
    })
    .from(users)
    .where(eq(users.email, email));
  if (
    existing !== undefined &&
    (existing.platformRole !== 'user' || existing.platformCapabilities != null)
  ) {
    throw new Error(`${email} has a platform role or capability override; refusing to reuse it`);
  }
}

/**
 * Hands a shared test-login user back as test-login would have created it. Refuses (before any
 * write) a row that carries a platform role or capability override, as the seed does.
 */
async function handBackTestLoginUser(db: HelpExecutor, email: string): Promise<void> {
  await assertPlainUserOrAbsent(db, email);
  await db
    .update(users)
    .set({
      firstName: TEST_LOGIN_FIRST_NAME,
      lastName: TEST_LOGIN_LAST_NAME,
      activeMode: 'client',
      activeCompanyId: null,
      avatarUrl: null,
      phoneVerifiedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(users.email, email));
}

async function ensureTestLoginUser(db: HelpExecutor, email: string): Promise<string> {
  await assertPlainUserOrAbsent(db, email);
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing !== undefined) {
    return existing.id;
  }
  // Mirrors `usersRepository.createWithWorkspace`: test-login needs the personal-workspace
  // membership to exist, so the user is never created without it.
  const [user] = await db
    .insert(users)
    .values({
      workosId: `e2e_${crypto.randomUUID()}`,
      email,
      firstName: TEST_LOGIN_FIRST_NAME,
      lastName: TEST_LOGIN_LAST_NAME,
      emailVerified: true,
      activeMode: 'client',
      onboardingCompleted: true,
    })
    .returning({ id: users.id });
  if (user === undefined) {
    throw new Error('users insert returned no row');
  }
  const [workspace] = await db
    .insert(companies)
    .values({ name: `${TEST_LOGIN_FIRST_NAME}'s Workspace`, isPersonal: true })
    .returning({ id: companies.id });
  if (workspace === undefined) {
    throw new Error('companies insert returned no row');
  }
  await db.insert(companyMembers).values({
    companyId: workspace.id,
    userId: user.id,
    role: 'owner',
    joinMethod: 'personal_workspace',
  });
  return user.id;
}

function consultationWindow(anchor: Date): { start: Date; end: Date } {
  const start = new Date(anchor);
  start.setUTCHours(CONSULTATION_START_HOUR_UTC, 0, 0, 0);
  return { start, end: new Date(start.getTime() + CONSULTATION_MINUTES * MS_PER_MINUTE) };
}

/** Anchor-relative instant: `days` after the anchor Monday at `hour`:00 UTC. */
function anchorInstant(anchor: Date, days: number, hour: number): Date {
  const instant = new Date(anchor.getTime() + days * MS_PER_DAY);
  instant.setUTCHours(hour, 0, 0, 0);
  return instant;
}

async function seedClientCompany(db: HelpExecutor, anchor: Date): Promise<string> {
  const danaId = await ensureTestLoginUser(db, HELP_CLIENT_EMAIL);
  await db
    .insert(companies)
    .values({ id: IDS.company, name: 'Northwind Industrial', isPersonal: false });
  await db.insert(companyMembers).values({
    companyId: IDS.company,
    userId: danaId,
    role: 'owner',
    joinMethod: 'owner',
  });
  // The active company is set AFTER the company row exists (FK).
  await db
    .update(users)
    .set({
      firstName: 'Dana',
      lastName: 'Whitfield',
      onboardingCompleted: true,
      emailVerified: true,
      activeMode: 'client',
      activeCompanyId: IDS.company,
      updatedAt: new Date(),
    })
    .where(eq(users.id, danaId));

  // A funded wallet with a live card mandate: balance = the single purchase ledger row.
  await db.insert(creditWallets).values({
    id: IDS.wallet,
    companyId: IDS.company,
    balanceMinor: WALLET_BALANCE_MINOR,
    currency: 'AUD',
    expiresAt: anchorInstant(anchor, 365, 0),
    lowBalanceMode: 'keep_going',
    stripeCustomerId: 'cus_helpfixture',
    stripePaymentMethodId: 'pm_helpfixture',
    mandateRef: 'seti_helpfixture',
    mandateStatus: 'active',
    cardBrand: 'visa',
    cardLast4: '4242',
    cardExpMonth: 12,
    cardExpYear: 2030,
  });
  await db.insert(creditLedger).values({
    id: IDS.ledgerPurchase,
    walletId: IDS.wallet,
    entryType: 'purchase',
    reason: 'manual_purchase',
    amountMinor: WALLET_BALANCE_MINOR,
    balanceAfterMinor: WALLET_BALANCE_MINOR,
    idempotencyKey: 'help-fixture-bal599-purchase',
  });
  return danaId;
}

async function seedBookedConsultation(
  db: HelpExecutor,
  anchor: Date,
  danaId: string
): Promise<void> {
  const { start, end } = consultationWindow(anchor);
  const roomName = `balo-${IDS.meeting.replaceAll('-', '')}`;

  // Case engagement: supertype + child + thread, as `caseEngagementsRepository.create` does.
  // `balo_fee_bps` is explicitly NULL: the column default (2500) violates the case CHECK.
  await db.insert(engagements).values({
    id: IDS.engagement,
    engagementType: 'case',
    companyId: IDS.company,
    expertProfileId: IDS.expertProfile,
    baloFeeBps: null,
    activatedAt: FIXED_DECISION_TIME,
  });
  await db.insert(caseEngagements).values({
    engagementId: IDS.engagement,
    title: 'Salesforce flow debugging',
    description: '<p>A quick question about a broken flow.</p>',
  });
  await db.insert(conversations).values({ id: IDS.conversation });
  await db.insert(conversationContexts).values({
    id: IDS.conversationContext,
    conversationId: IDS.conversation,
    contextType: 'engagement',
    contextId: IDS.engagement,
  });

  // The meeting, its `case` context and the confirmed `consultations` projection row that
  // `meetingsRepository.listCalendarForExpert` joins through.
  await db.insert(meetings).values({
    id: IDS.meeting,
    scheduledStart: start,
    scheduledEnd: end,
    dailyRoomName: roomName,
    joinUrl: `https://help-fixture.invalid/${roomName}`,
  });
  await db.insert(meetingContexts).values({
    id: IDS.meetingContext,
    meetingId: IDS.meeting,
    contextType: 'case',
    contextId: IDS.engagement,
  });
  await db.insert(consultations).values({
    id: IDS.consultation,
    meetingId: IDS.meeting,
    expertProfileId: IDS.expertProfile,
    startAt: start,
    endAt: end,
    status: 'confirmed',
  });

  // An email-invited guest, as `meetingGuestsRepository.createMany` writes one for a client
  // invite: pre-admitted, client side, scoped to this meeting. Only the token HASH is stored.
  await db.insert(meetingGuests).values({
    id: IDS.guest,
    meetingId: IDS.meeting,
    email: 'sam.lee@northwind.example',
    name: 'Sam Lee',
    emailDomain: 'northwind.example',
    party: 'client',
    participationRole: 'guest',
    accessScope: 'meeting',
    inviteChannel: 'email',
    admission: 'pre_admitted',
    invitedById: danaId,
    tokenHash: createHash('sha256').update(HELP_GUEST_TOKEN).digest('hex'),
    expiresAt: anchorInstant(anchor, 7, 0),
  });
}

const PAYOUT_DETAILS = {
  id: IDS.payoutDetails,
  expertProfileId: IDS.expertProfile,
  countryCode: 'AU',
  currency: 'AUD',
  entityType: 'PERSONAL',
  tradingName: 'Priya Raman',
  // Already-masked display values, as the saved payout card renders them. Obviously fake.
  formValues: {
    'beneficiary.bank_details.account_name': 'Priya Raman',
    'beneficiary.bank_details.account_routing_value1': '062-***',
    'beneficiary.bank_details.account_number': '****6789',
  },
  beneficiaryStatus: 'verified',
  verifiedAt: FIXED_DECISION_TIME,
} as const;

export async function seedHelpFixture(db: HelpExecutor, anchor: Date): Promise<void> {
  const [salesforce] = await db
    .select({ id: verticals.id })
    .from(verticals)
    .where(eq(verticals.slug, 'salesforce'));
  if (salesforce === undefined) {
    throw new Error('Salesforce vertical not found - run `pnpm db:seed` first');
  }

  await resetHelpFixture(db);
  const expertUserId = await ensureTestLoginUser(db, HELP_EXPERT_EMAIL);

  await db
    .update(users)
    .set({
      firstName: 'Priya',
      lastName: 'Raman',
      onboardingCompleted: true,
      emailVerified: true,
      activeMode: 'expert',
      avatarUrl: HELP_AVATAR_URL,
      phoneVerifiedAt: FIXED_DECISION_TIME,
      updatedAt: new Date(),
    })
    .where(eq(users.id, expertUserId));

  await db.insert(expertProfiles).values({
    id: IDS.expertProfile,
    userId: expertUserId,
    verticalId: salesforce.id,
    type: 'freelancer',
    username: 'priya-raman',
    headline: 'Salesforce architect for flows, data models and integrations',
    bio: 'Fifteen years across Sales and Service Cloud, helping teams untangle automation and ship cleaner orgs.',
    rateCents: 300,
    searchable: true,
    availableForWork: true,
    applicationStatus: 'approved',
    submittedAt: FIXED_DECISION_TIME,
    decidedAt: FIXED_DECISION_TIME,
    approvedAt: FIXED_DECISION_TIME,
    timezone: 'UTC',
  });
  await db.insert(availabilityRules).values(
    HELP_AVAILABILITY_RULE_IDS.map((id, index) => ({
      id,
      expertProfileId: IDS.expertProfile,
      dayOfWeek: index + 1,
      startTime: '09:00',
      endTime: '17:00',
    }))
  );

  // The remaining two checklist items (`deriveExpertChecklist`): a live ACTIVE calendar
  // connection and payout details. Without all six, the dashboard read path flips `searchable`
  // to false and the public profile 404s. The connection names a target calendar and the
  // sub-calendar opts out of conflict checks, so slot reads never call a calendar vendor.
  await db.insert(calendarConnections).values({
    id: IDS.calendarConnection,
    expertProfileId: IDS.expertProfile,
    endUserAccountId: 'help-fixture-account',
    provider: 'google',
    providerEmail: 'priya.raman@example.com',
    credentialStatus: 'ACTIVE',
    targetCalendarId: 'priya-primary',
  });
  await db.insert(calendarSubCalendars).values({
    id: IDS.subCalendar,
    connectionId: IDS.calendarConnection,
    calendarId: 'priya-primary',
    name: 'Priya Raman',
    provider: 'google',
    isPrimary: true,
    conflictCheck: false,
  });
  await db.insert(expertPayoutDetails).values(PAYOUT_DETAILS);

  const danaId = await seedClientCompany(db, anchor);
  await seedBookedConsultation(db, anchor, danaId);
}

async function requireSeeded(db: HelpExecutor): Promise<string> {
  const [profile] = await db
    .select({ userId: expertProfiles.userId })
    .from(expertProfiles)
    .where(eq(expertProfiles.id, IDS.expertProfile));
  if (profile === undefined) {
    throw new Error('Help fixture is not seeded - run `pnpm help:seed` first');
  }
  return profile.userId;
}

function fridayRuleId(): string {
  const [, , , , friday] = HELP_AVAILABILITY_RULE_IDS;
  if (friday === undefined) {
    throw new Error('Friday availability rule id is missing');
  }
  return friday;
}

async function deleteAutoClosedCase(db: HelpExecutor): Promise<void> {
  await db.delete(conversations).where(eq(conversations.id, IDS.autoClosedConversation));
  await db.delete(engagements).where(eq(engagements.id, IDS.autoClosedEngagement));
}

/** Assigns every column a state can change, so states are order-independent. */
async function restoreBase(db: HelpExecutor, anchor: Date): Promise<void> {
  const { start, end } = consultationWindow(anchor);
  const now = new Date();

  // The session sync flips activeMode to client while the expert profile is rejected, and
  // /expert/* redirects away from expert pages until it is set back.
  await db
    .update(users)
    .set({ activeMode: 'expert', updatedAt: now })
    .where(eq(users.email, HELP_EXPERT_EMAIL));
  await db
    .update(expertProfiles)
    .set({
      availableForWork: true,
      applicationStatus: 'approved',
      submittedAt: FIXED_DECISION_TIME,
      decidedAt: FIXED_DECISION_TIME,
      approvedAt: FIXED_DECISION_TIME,
      searchable: true,
      updatedAt: now,
    })
    .where(eq(expertProfiles.id, IDS.expertProfile));
  await db
    .update(availabilityRules)
    .set({ startTime: '09:00', endTime: '17:00', updatedAt: now })
    .where(eq(availabilityRules.id, fridayRuleId()));
  await db
    .update(calendarConnections)
    .set({ credentialStatus: 'ACTIVE', updatedAt: now })
    .where(eq(calendarConnections.id, IDS.calendarConnection));
  await db.insert(expertPayoutDetails).values(PAYOUT_DETAILS).onConflictDoNothing();

  await db
    .update(meetings)
    .set({
      status: 'scheduled',
      outcome: null,
      endedBy: null,
      scheduledStart: start,
      scheduledEnd: end,
      startedAt: null,
      endedAt: null,
      updatedAt: now,
    })
    .where(eq(meetings.id, IDS.meeting));
  await db
    .update(consultations)
    .set({ startAt: start, endAt: end, status: 'confirmed', updatedAt: now })
    .where(eq(consultations.id, IDS.consultation));

  await db
    .delete(rescheduleProposalOptions)
    .where(
      inArray(rescheduleProposalOptions.id, [
        IDS.proposalOption1,
        IDS.proposalOption2,
        IDS.proposalOption3,
      ])
    );
  await db.delete(rescheduleProposals).where(eq(rescheduleProposals.id, IDS.proposal));

  await db
    .update(companyMembers)
    .set({ role: 'owner' })
    .where(eq(companyMembers.companyId, IDS.company));
  await deleteAutoClosedCase(db);
}

async function insertProposal(db: HelpExecutor, anchor: Date, expertUserId: string): Promise<void> {
  const { start } = consultationWindow(anchor);
  await db.insert(rescheduleProposals).values({
    id: IDS.proposal,
    meetingId: IDS.meeting,
    proposedByUserId: expertUserId,
    status: 'pending',
    originalScheduledStart: start,
    expiresAt: new Date(start.getTime() - MINUTES_PER_HOUR * MS_PER_MINUTE),
  });
  const slots = [
    { id: IDS.proposalOption1, days: 1, hour: 10 },
    { id: IDS.proposalOption2, days: 2, hour: 11 },
    { id: IDS.proposalOption3, days: 3, hour: 15 },
  ];
  await db.insert(rescheduleProposalOptions).values(
    slots.map((slot, position) => {
      const scheduledStart = anchorInstant(anchor, slot.days, slot.hour);
      return {
        id: slot.id,
        proposalId: IDS.proposal,
        position,
        scheduledStart,
        scheduledEnd: new Date(scheduledStart.getTime() + CONSULTATION_MINUTES * MS_PER_MINUTE),
      };
    })
  );
}

/** The call ended a quarter of an hour ago, so the server-rendered end page sees a real clock. */
async function markCallHeld(db: HelpExecutor): Promise<void> {
  const now = Date.now();
  const start = new Date(now - 75 * MS_PER_MINUTE);
  const end = new Date(now - 15 * MS_PER_MINUTE);
  await db
    .update(meetings)
    .set({
      scheduledStart: start,
      scheduledEnd: end,
      startedAt: start,
      endedAt: end,
      updatedAt: new Date(),
    })
    .where(eq(meetings.id, IDS.meeting));
  await db
    .update(consultations)
    .set({ startAt: start, endAt: end, updatedAt: new Date() })
    .where(eq(consultations.id, IDS.consultation));
}

async function insertAutoClosedCase(db: HelpExecutor, anchor: Date): Promise<void> {
  await db.insert(engagements).values({
    id: IDS.autoClosedEngagement,
    engagementType: 'case',
    companyId: IDS.company,
    expertProfileId: IDS.expertProfile,
    baloFeeBps: null,
    activatedAt: FIXED_DECISION_TIME,
  });
  await db.insert(caseEngagements).values({
    engagementId: IDS.autoClosedEngagement,
    title: 'Reporting dashboard question',
    description: '<p>A question about a dashboard filter.</p>',
    closedAt: anchorInstant(anchor, -10, 10),
    closeReason: 'auto_inactive',
  });
  // `caseHasLiveThread` hides a case with no thread from /cases, closed or not.
  await db.insert(conversations).values({ id: IDS.autoClosedConversation });
  await db.insert(conversationContexts).values({
    id: IDS.autoClosedConversationContext,
    conversationId: IDS.autoClosedConversation,
    contextType: 'engagement',
    contextId: IDS.autoClosedEngagement,
  });
}

/** Restores every mutable column to its base value, then applies the state's delta. */
export async function applyHelpState(
  db: HelpExecutor,
  state: HelpFixtureState,
  anchor: Date
): Promise<void> {
  const expertUserId = await requireSeeded(db);
  await restoreBase(db, anchor);

  switch (state) {
    case 'available':
      return;
    case 'paused':
      await db
        .update(expertProfiles)
        .set({ availableForWork: false, updatedAt: new Date() })
        .where(eq(expertProfiles.id, IDS.expertProfile));
      return;
    case 'proposal':
      await insertProposal(db, anchor, expertUserId);
      return;
    case 'held':
      await markCallHeld(db);
      return;
    case 'calendar-pending':
      await db
        .update(calendarConnections)
        .set({ credentialStatus: 'SYNC_PENDING', updatedAt: new Date() })
        .where(eq(calendarConnections.id, IDS.calendarConnection));
      return;
    case 'overnight':
      // End before start renders "Continues into Saturday".
      await db
        .update(availabilityRules)
        .set({ startTime: '22:00', endTime: '02:00', updatedAt: new Date() })
        .where(eq(availabilityRules.id, fridayRuleId()));
      return;
    case 'setup-incomplete':
      await db.delete(expertPayoutDetails).where(eq(expertPayoutDetails.id, IDS.payoutDetails));
      return;
    case 'rejected':
      // Seven days ago sits inside the 60-day cooldown, so the page shows the dated copy.
      await db
        .update(expertProfiles)
        .set({
          applicationStatus: 'rejected',
          approvedAt: null,
          decidedAt: new Date(Date.now() - 7 * MS_PER_DAY),
          searchable: false,
          updatedAt: new Date(),
        })
        .where(eq(expertProfiles.id, IDS.expertProfile));
      return;
    case 'client-member':
      await db
        .update(companyMembers)
        .set({ role: 'member' })
        .where(eq(companyMembers.companyId, IDS.company));
      return;
    case 'auto-closed':
      await insertAutoClosedCase(db, anchor);
      return;
    default: {
      const unhandled: never = state;
      throw new Error(`Unknown help fixture state: ${String(unhandled)}`);
    }
  }
}
