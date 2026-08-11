import { db } from '../../client';
import {
  caseEngagements,
  companies,
  conversationContexts,
  conversations,
  engagements,
} from '../../schema';
import type { NewCaseEngagement, NewEngagement } from '../../schema';
import { toCaseRow, type CaseEngagementRow } from '../../repositories/case-engagements';
import { companyMemberFactory } from './company.factory';
import { expertDraftFactory } from './expert-draft.factory';
import { userFactory } from './user.factory';

interface CaseEngagementFactoryOverrides {
  /** Reuse an existing company instead of seeding a personal one. */
  companyId?: string;
  /** The delivering expert. Defaults to a fresh expert draft. */
  expertProfileId?: string;
  /**
   * Seed a LIVE `company_members` row for a fresh user and return their id as
   * `clientMemberUserId` — the coherent closer for
   * `caseEngagementsRepository.close({ reason: 'resolved', userId })`, whose
   * `closed_by_user_id`-must-be-a-live-member invariant needs one.
   */
  withClientMember?: boolean;
  /**
   * SUPERTYPE row overrides. Unlike the project factory, `status` IS permitted here:
   * a Case has no sub-status, so there is no projection invariant to violate.
   * `engagementType` is excluded — this factory seeds CASES.
   */
  values?: Omit<Partial<NewEngagement>, 'engagementType'>;
  /** CASE CHILD overrides (title, description, closedAt, deletedAt, …). */
  caseValues?: Omit<Partial<NewCaseEngagement>, 'engagementId' | 'engagementType'>;
}

export interface CaseEngagementFactoryResult {
  /** FLAT case row — the supertype columns MINUS `baloFeeBps`, plus the case columns. */
  engagement: CaseEngagementRow;
  companyId: string;
  expertProfileId: string;
  /** Present only when `withClientMember` was set. */
  clientMemberUserId?: string;
  /**
   * The case's thread, anchored on the `engagement` label (BAL-424). Provisioned here
   * because production `caseEngagementsRepository.create` provisions it in the same
   * transaction. NO `relationship` context row exists anywhere for a Case — that is the
   * ticket's acceptance criterion, asserted directly in the integration tests.
   */
  conversationId: string;
}

async function seedPersonalCompanyId(): Promise<string> {
  const [company] = await db
    .insert(companies)
    .values({ name: 'Acme Co', isPersonal: true })
    .returning();
  if (company === undefined) {
    throw new Error('company insert failed');
  }
  return company.id;
}

/**
 * Seeds a CASE engagement — the `engagements` supertype row PLUS its
 * `case_engagements` child, in ONE transaction (BAL-417).
 *
 * `description` defaults to already-sanitised HTML, matching what a real web caller
 * would pass (`@balo/db` never sanitises — D8).
 */
export async function caseEngagementFactory(
  overrides: CaseEngagementFactoryOverrides = {}
): Promise<CaseEngagementFactoryResult> {
  const companyId = overrides.companyId ?? (await seedPersonalCompanyId());
  const expertProfileId = overrides.expertProfileId ?? (await expertDraftFactory()).id;

  let clientMemberUserId: string | undefined;
  if (overrides.withClientMember === true) {
    const member = await userFactory();
    await companyMemberFactory({ companyId, userId: member.id });
    clientMemberUserId = member.id;
  }

  const { engagement, conversationId } = await db.transaction(async (tx) => {
    const [parent] = await tx
      .insert(engagements)
      .values({
        engagementType: 'case',
        companyId,
        expertProfileId,
        // EXPLICIT NULL, exactly as `caseEngagementsRepository.create` does. The column
        // DEFAULT is 2500 and `engagement_balo_fee_bps_case_null` rejects any non-NULL
        // fee on a case, so omitting this would 23514 every case fixture.
        baloFeeBps: null,
        activatedAt: new Date(),
        ...overrides.values,
      })
      .returning();
    if (parent === undefined) {
      throw new Error('engagement insert failed');
    }

    const [child] = await tx
      .insert(caseEngagements)
      .values({
        engagementId: parent.id,
        title: 'Salesforce flow debugging',
        description: '<p>A quick question about a broken flow.</p>',
        ...overrides.caseValues,
        // The child mirrors the parent's soft-delete flag (see engagement.factory.ts).
        ...(overrides.values?.deletedAt === undefined
          ? {}
          : { deletedAt: overrides.values.deletedAt }),
      })
      .returning();
    if (child === undefined) {
      throw new Error('case engagement insert failed');
    }

    // BAL-424 — the case's thread, on the `engagement` label. RAW inserts (the factory
    // must be able to seed shapes the repository refuses, e.g. a pre-closed or
    // pre-soft-deleted case).
    const [conversation] = await tx.insert(conversations).values({}).returning();
    if (conversation === undefined) {
      throw new Error('conversation insert failed');
    }
    await tx.insert(conversationContexts).values({
      conversationId: conversation.id,
      contextType: 'engagement',
      contextId: parent.id,
    });

    // PRODUCTION fold — deliberately NOT re-implemented here. A duplicated destructure
    // would keep this factory (and every assertion made against it) green after the
    // production strip in `toCaseRow` was deleted, silently re-admitting the raw
    // `baloFeeBps` margin into the case projection.
    return { engagement: toCaseRow(parent, child), conversationId: conversation.id };
  });

  return { engagement, companyId, expertProfileId, clientMemberUserId, conversationId };
}
