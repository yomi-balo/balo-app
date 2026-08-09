/**
 * BAL-129 — the party graph a booking needs, built from the SAME repositories a real caller
 * would use.
 *
 * ⚠ WHY THIS IS A NEW, PURPOSE-BUILT FIXTURE RATHER THAN A SHARED HELPER. `apps/api` CANNOT
 * import `packages/db/src/test/factories/*`: they are not in `@balo/db`'s `exports`, and
 * reaching them by relative path pulls `packages/db/src/**` into `apps/api`'s tsconfig
 * program as SOURCE, failing `tsc --noEmit` with TS6059 on `rootDir: "src"`. Widening
 * `exports` would make test-only helpers importable from production code. So this follows
 * the `seedBookableExpert` precedent in
 * `services/availability/booking-availability.integration.test.ts` and builds the graph
 * through the public repositories.
 *
 * ⚠ IT IS NOT A COPY OF `seedBookableExpert`, AND IT DELIBERATELY SEEDS LESS: NO availability
 * rules and NO timezone pinning. Those are most of what that helper does and none of what
 * BAL-129 needs — this ticket proves the provisioning seam (meeting + context + projection +
 * room), not the availability resolver. `booking-availability.integration.test.ts` is
 * DELIBERATELY NOT refactored onto this: touching BAL-428's end-to-end proof file to save
 * twenty lines risks more than it saves.
 */
import {
  companies,
  companyMembers,
  db,
  expertsRepository,
  caseEngagementsRepository,
  projectRequestsRepository,
  referenceDataRepository,
  usersRepository,
} from '@balo/db';
import { randomUUID } from 'node:crypto';

export interface BookingParties {
  /**
   * ⚠ `companyId` AND `memberUserId` ARE WHAT MAKE TWO CALLS TWO TENANTS. The provisioning
   * cases below the fixture only need the context ids, but `book-and-provision.integration.
   * test.ts`'s tenancy block runs `authorizeMeetingBooking` for real across two invocations —
   * A's member against B's engagement — which is the only place BAL-129's headline security
   * claim is EXECUTED rather than read. Do not prune these as unused.
   */
  companyId: string;
  /** A LIVE `member` of `companyId` — the actor a real booking would authorize as. */
  memberUserId: string;
  expertProfileId: string;
  /** A live `case` engagement: `companyId` × `expertProfileId`. */
  caseEngagementId: string;
  /** A `send_to='direct'` request routed to `expertProfileId` — bookable as discovery. */
  directProjectRequestId: string;
  /** A `send_to='match'` request with NO expert — deliberately NOT bookable. */
  matchProjectRequestId: string;
}

/**
 * Seed one client company with a member, one expert, a live case engagement, and both
 * routing shapes of project request. Every id is fresh per call, so two invocations inside
 * one test are two independent tenants.
 */
export async function seedBookingParties(): Promise<BookingParties> {
  const marker = randomUUID();

  const memberUser = await usersRepository.create({
    workosId: `bal129_member_${marker}`,
    email: `bal129-member-${marker}@test.local`,
    firstName: 'Booking',
    lastName: 'Member',
  });

  const expertUser = await usersRepository.create({
    workosId: `bal129_expert_${marker}`,
    email: `bal129-expert-${marker}@test.local`,
    firstName: 'Booked',
    lastName: 'Expert',
  });

  // Seeded by `global-setup.ts` and never rolled back, so this always resolves.
  const vertical = await referenceDataRepository.getSalesforceVertical();
  const profile = await expertsRepository.createDraft({
    userId: expertUser.id,
    verticalId: vertical.id,
    type: 'freelancer',
    firstName: 'Booked',
    lastName: 'Expert',
  });

  const [company] = await db
    .insert(companies)
    .values({ name: `BAL-129 client ${marker}`, isPersonal: false })
    .returning({ id: companies.id });
  if (company === undefined) {
    throw new Error('fixture: company insert returned no row');
  }

  // Inserted directly: `partyMembershipsRepository` exposes only the domain-match join path,
  // and this fixture needs a plain invited `member`.
  await db
    .insert(companyMembers)
    .values({ companyId: company.id, userId: memberUser.id, role: 'member' });

  const engagement = await caseEngagementsRepository.create({
    companyId: company.id,
    expertProfileId: profile.id,
    title: `BAL-129 booking fixture ${marker}`,
    description: '<p>Already-sanitised HTML, exactly as a real web caller would pass.</p>',
  });

  const directRequest = await projectRequestsRepository.createProjectRequest({
    request: {
      companyId: company.id,
      createdByUserId: memberUser.id,
      // The `project_request_send_to_expert` CHECK: `direct` REQUIRES an expert.
      sendTo: 'direct',
      expertProfileId: profile.id,
      title: `BAL-129 direct request ${marker}`,
      description: '<p>Direct discovery request.</p>',
    },
    tagIds: [],
    productIds: [],
    documents: [],
  });

  const matchRequest = await projectRequestsRepository.createProjectRequest({
    request: {
      companyId: company.id,
      createdByUserId: memberUser.id,
      // …and `match` REQUIRES its absence. NULL there is precisely what
      // `MatchModeDiscoveryNotBookableError` reports on.
      sendTo: 'match',
      title: `BAL-129 match request ${marker}`,
      description: '<p>Unrouted discovery request.</p>',
    },
    tagIds: [],
    productIds: [],
    documents: [],
  });

  return {
    companyId: company.id,
    memberUserId: memberUser.id,
    expertProfileId: profile.id,
    caseEngagementId: engagement.id,
    directProjectRequestId: directRequest.id,
    matchProjectRequestId: matchRequest.id,
  };
}
