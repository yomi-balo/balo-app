import { eq } from 'drizzle-orm';
import type { Database } from '../client';
import {
  availabilityRules,
  calendarConnections,
  caseEngagements,
  companies,
  companyMembers,
  consultations,
  conversationContexts,
  conversations,
  engagements,
  expertPayoutDetails,
  expertProfiles,
  meetingContexts,
  meetings,
  users,
  verticals,
} from '../schema';

/**
 * Help-centre screenshot fixture (BAL-598). Gives the shared `onboarded-e2e@balo.test` user an
 * approved expert profile (Priya Raman), plus one client company (Northwind Industrial) with a
 * booked consultation in the coming week. Every row the fixture owns has a fixed id below, so
 * `resetHelpFixture` removes exactly what `seedHelpFixture` added and nothing else.
 *
 * Rows are written with raw drizzle on purpose (the `seed.ts` exception): the test factories
 * randomise, and a screenshot fixture must be byte-stable.
 */

type HelpExecutor = Pick<Database, 'insert' | 'update' | 'delete' | 'select'>;

export type HelpAvailabilityState = 'available' | 'paused';

export const HELP_EXPERT_EMAIL = 'onboarded-e2e@balo.test';
const CLIENT_OWNER_EMAIL = 'dana-help@balo.test';

/** Name test-login gives the shared user when it creates it; `reset` restores this. */
const TEST_LOGIN_FIRST_NAME = 'E2E';
const TEST_LOGIN_LAST_NAME = 'Test';

const IDS = {
  expertProfile: 'b1a10598-0000-4000-8000-000000000001',
  company: 'b1a10598-0000-4000-8000-000000000002',
  clientOwner: 'b1a10598-0000-4000-8000-000000000003',
  engagement: 'b1a10598-0000-4000-8000-000000000005',
  conversation: 'b1a10598-0000-4000-8000-000000000006',
  meeting: 'b1a10598-0000-4000-8000-000000000007',
  consultation: 'b1a10598-0000-4000-8000-000000000008',
  meetingContext: 'b1a10598-0000-4000-8000-000000000009',
  conversationContext: 'b1a10598-0000-4000-8000-00000000000a',
  calendarConnection: 'b1a10598-0000-4000-8000-00000000000b',
  payoutDetails: 'b1a10598-0000-4000-8000-00000000000c',
} as const;

const AVAILABILITY_RULE_IDS = [1, 2, 3, 4, 5].map(
  (day) => `b1a10598-0000-4000-8000-0000000001${String(day).padStart(2, '0')}`
);

/** A repo-served asset, so the avatar needs no new public file and renders identically each run. */
const HELP_AVATAR_URL = '/brand/balo-icon.png';

const FIXED_DECISION_TIME = new Date('2026-01-05T00:00:00Z');
const CONSULTATION_START_HOUR_UTC = 14;
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

export async function resetHelpFixture(db: HelpExecutor): Promise<void> {
  // FK-safe order. Meetings cascade to contexts + consultations; engagements to case rows.
  await db.delete(meetings).where(eq(meetings.id, IDS.meeting));
  await db.delete(conversations).where(eq(conversations.id, IDS.conversation));
  await db.delete(engagements).where(eq(engagements.id, IDS.engagement));
  await db
    .delete(availabilityRules)
    .where(eq(availabilityRules.expertProfileId, IDS.expertProfile));
  await db.delete(expertProfiles).where(eq(expertProfiles.id, IDS.expertProfile));
  await db.delete(companyMembers).where(eq(companyMembers.companyId, IDS.company));
  await db.delete(companies).where(eq(companies.id, IDS.company));
  await db.delete(users).where(eq(users.id, IDS.clientOwner));
  // The shared e2e user stays: hand it back as test-login would have created it.
  await db
    .update(users)
    .set({
      firstName: TEST_LOGIN_FIRST_NAME,
      lastName: TEST_LOGIN_LAST_NAME,
      activeMode: 'client',
      avatarUrl: null,
      phoneVerifiedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(users.email, HELP_EXPERT_EMAIL));
}

async function ensureExpertUser(db: HelpExecutor): Promise<string> {
  const [existing] = await db
    .select({
      id: users.id,
      platformRole: users.platformRole,
      platformCapabilities: users.platformCapabilities,
    })
    .from(users)
    .where(eq(users.email, HELP_EXPERT_EMAIL));
  if (existing !== undefined) {
    // Mirrors test-login's refusal: never silently strip staff access from a real account.
    if (existing.platformRole !== 'user' || existing.platformCapabilities != null) {
      throw new Error(
        `${HELP_EXPERT_EMAIL} has a platform role or capability override; refusing to reuse it`
      );
    }
    return existing.id;
  }
  // Mirrors `usersRepository.createWithWorkspace`: test-login needs the personal-workspace
  // membership to exist, so the user is never created without it.
  const [user] = await db
    .insert(users)
    .values({
      workosId: `e2e_${crypto.randomUUID()}`,
      email: HELP_EXPERT_EMAIL,
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

async function seedClientCompany(db: HelpExecutor): Promise<void> {
  await db.insert(users).values([
    {
      id: IDS.clientOwner,
      workosId: 'help_dana_whitfield',
      email: CLIENT_OWNER_EMAIL,
      firstName: 'Dana',
      lastName: 'Whitfield',
      emailVerified: true,
      onboardingCompleted: true,
    },
  ]);
  await db
    .insert(companies)
    .values({ id: IDS.company, name: 'Northwind Industrial', isPersonal: false });
  await db.insert(companyMembers).values({
    companyId: IDS.company,
    userId: IDS.clientOwner,
    role: 'owner',
    joinMethod: 'owner',
  });
}

async function seedBookedConsultation(db: HelpExecutor, anchor: Date): Promise<void> {
  const start = new Date(anchor);
  start.setUTCHours(CONSULTATION_START_HOUR_UTC, 0, 0, 0);
  const end = new Date(start.getTime() + CONSULTATION_MINUTES * MS_PER_MINUTE);

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
  await db.insert(meetings).values({ id: IDS.meeting, scheduledStart: start, scheduledEnd: end });
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
}

export async function seedHelpFixture(db: HelpExecutor, anchor: Date): Promise<void> {
  const [salesforce] = await db
    .select({ id: verticals.id })
    .from(verticals)
    .where(eq(verticals.slug, 'salesforce'));
  if (salesforce === undefined) {
    throw new Error('Salesforce vertical not found - run `pnpm db:seed` first');
  }

  await resetHelpFixture(db);
  const expertUserId = await ensureExpertUser(db);

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
    AVAILABILITY_RULE_IDS.map((id, index) => ({
      id,
      expertProfileId: IDS.expertProfile,
      dayOfWeek: index + 1,
      startTime: '09:00',
      endTime: '17:00',
    }))
  );

  // The remaining two checklist items (`deriveExpertChecklist`): a live ACTIVE calendar
  // connection and payout details. Without all six, the dashboard read path flips `searchable`
  // to false and the public profile 404s.
  await db.insert(calendarConnections).values({
    id: IDS.calendarConnection,
    expertProfileId: IDS.expertProfile,
    endUserAccountId: 'help-fixture-account',
    provider: 'google',
    providerEmail: 'priya.raman@example.com',
    credentialStatus: 'ACTIVE',
  });
  await db.insert(expertPayoutDetails).values({
    id: IDS.payoutDetails,
    expertProfileId: IDS.expertProfile,
    countryCode: 'AU',
    currency: 'AUD',
    entityType: 'PERSONAL',
    formValues: {},
  });

  await seedClientCompany(db);
  await seedBookedConsultation(db, anchor);
}

export async function setHelpAvailability(
  db: HelpExecutor,
  state: HelpAvailabilityState
): Promise<void> {
  const updated = await db
    .update(expertProfiles)
    .set({ availableForWork: state === 'available', updatedAt: new Date() })
    .where(eq(expertProfiles.id, IDS.expertProfile))
    .returning({ id: expertProfiles.id });
  if (updated.length === 0) {
    throw new Error('Help fixture is not seeded - run `pnpm help:seed` first');
  }
}
