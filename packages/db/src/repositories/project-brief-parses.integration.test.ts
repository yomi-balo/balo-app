import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type {
  ProjectBriefParseResult,
  ProjectBriefParseSourceDocument,
} from '@balo/shared/project-requests';
import { db } from '../client';
import { projectBriefParses } from '../schema';
import type { Company, User } from '../schema';
import { companyFactory, userFactory } from '../test/factories';
import { expectConstraintViolation } from '../test/helpers/expect-check-violation';
import {
  projectBriefParsesRepository,
  toProjectBriefParseState,
  type ProjectBriefParseAudit,
  type ProjectBriefParseUsage,
} from './project-brief-parses';

/**
 * BAL-254 — `project_brief_parses`, the AI brief parse's async handoff row.
 *
 * Four things this suite exists to hold, beyond the usual happy paths:
 *
 *  1. **§12 GATE 4 — a cross-tenant `parseId` is a NOT-FOUND.** `findForOwner` carries BOTH
 *     `company_id` and `requested_by_user_id` in its WHERE, so the poll action cannot
 *     distinguish "not yours" from "does not exist". This is the assertion the security review
 *     comes here for, and it is exercised for a wrong company AND for a wrong user, because a
 *     lookup that dropped either term would still pass the other's test.
 *  2. **TERMINAL IS TERMINAL.** Both `mark*` are CAS-guarded on `completed_at IS NULL`. BullMQ
 *     delivers at least once, so the second delivery is an ordinary event — it must return
 *     `undefined` and leave the row byte-identical, not overwrite a result the client may
 *     already have written into their draft.
 *  3. **BOTH CHECKS REALLY REJECT.** `single_outcome` and `completion_carries_an_outcome` are
 *     what make "no `status` column" (D3) a safe design rather than a convention. A violation
 *     is a runtime 23514 — invisible to `tsc`, and invisible to any mocked unit test.
 *  4. **`source_documents` jsonb round-trips intact.** It is the security-relevant column: the
 *     worker reads the R2 keys from it and from nowhere else.
 *
 * ⚠ EACH CHECK PROBE RUNS IN ITS OWN `it()` **AND** ITS OWN SAVEPOINT (via
 * `expectConstraintViolation`). The harness holds every test inside one outer transaction and a
 * failed statement ABORTS it — every later statement would then answer `25P02 current
 * transaction is aborted` instead of the code under test (memory
 * `reference_caught_23505_aborts_test_transaction`, which applies identically to 23514).
 *
 * ⚠ CONCURRENCY IS NOT EXPRESSIBLE HERE. The harness runs one transaction on a `max:1` pool
 * (memory `reference_db_integration_harness_no_concurrency`), so the CAS is proven by
 * SEQUENTIAL redelivery — which is the shape BullMQ actually produces — and not by two
 * simultaneous writers.
 */

const AUDIT: ProjectBriefParseAudit = {
  modelId: 'claude-opus-5',
  modelVersion: '20260101',
  promptId: 'project-brief-extract',
  promptVersion: 'v1',
};

const USAGE: ProjectBriefParseUsage = { inputTokens: 12_345, outputTokens: 678 };

/**
 * ⚠ NO DATES ANYWHERE IN THIS SHAPE, AND IT MUST STAY THAT WAY — memory
 * `reference_jsonb_date_type_lie`: a `Date` written into jsonb reads back as an ISO string
 * while still typed `Date`, so a round-trip assertion on it would pass while lying.
 */
function sourceDocuments(): ProjectBriefParseSourceDocument[] {
  return [
    {
      r2Key: `project-documents/${randomUUID()}/${randomUUID()}/${randomUUID()}`,
      fileName: 'rfp.pdf',
      contentType: 'application/pdf',
      sizeBytes: 482_113,
    },
    {
      r2Key: `project-documents/${randomUUID()}/${randomUUID()}/${randomUUID()}`,
      fileName: 'architecture.png',
      contentType: 'image/png',
      sizeBytes: 91_204,
    },
  ];
}

function parseResult(overrides: Partial<ProjectBriefParseResult> = {}): ProjectBriefParseResult {
  return {
    title: 'Migrate Sales Cloud reporting to CRM Analytics',
    descriptionMarkdown: '## Context\n\nNorthwind runs 40 legacy reports.\n\n- Consolidate\n',
    tagIds: [randomUUID()],
    productIds: [randomUUID()],
    unmatchedTagLabels: ['Revenue Cloud Advanced'],
    unmatchedProductLabels: [],
    ...overrides,
  };
}

/** One requester with their company — the pair every ownership-scoped read is keyed on. */
async function seedOwner(): Promise<{ user: User; company: Company }> {
  const [user, company] = await Promise.all([userFactory(), companyFactory()]);
  return { user, company };
}

async function seedPendingParse(): Promise<{
  user: User;
  company: Company;
  parseId: string;
}> {
  const { user, company } = await seedOwner();
  const row = await projectBriefParsesRepository.create({
    companyId: company.id,
    requestedByUserId: user.id,
    sourceDocuments: sourceDocuments(),
  });
  return { user, company, parseId: row.id };
}

describe('projectBriefParsesRepository.create / findById', () => {
  it('opens a PENDING row — three NULL facts, no status column (D3)', async () => {
    const { user, company } = await seedOwner();

    const created = await projectBriefParsesRepository.create({
      companyId: company.id,
      requestedByUserId: user.id,
      sourceDocuments: sourceDocuments(),
    });

    expect(created.completedAt).toBeNull();
    expect(created.result).toBeNull();
    expect(created.failureReason).toBeNull();
    expect(created.deletedAt).toBeNull();
    expect(created.companyId).toBe(company.id);
    expect(created.requestedByUserId).toBe(user.id);
    expect(toProjectBriefParseState(created)).toEqual({ state: 'pending', row: created });
  });

  it('round-trips source_documents jsonb intact — the keys the worker reads', async () => {
    const { user, company } = await seedOwner();
    const documents = sourceDocuments();

    const created = await projectBriefParsesRepository.create({
      companyId: company.id,
      requestedByUserId: user.id,
      sourceDocuments: documents,
    });
    const read = await projectBriefParsesRepository.findById(created.id);

    expect(read?.sourceDocuments).toEqual(documents);
  });

  it('findById returns undefined for an unknown id', async () => {
    expect(await projectBriefParsesRepository.findById(randomUUID())).toBeUndefined();
  });
});

describe('projectBriefParsesRepository.findForOwner — §12 GATE 4', () => {
  it('returns the row for the owning (company, user) pair', async () => {
    const { user, company, parseId } = await seedPendingParse();

    const found = await projectBriefParsesRepository.findForOwner({
      parseId,
      companyId: company.id,
      requestedByUserId: user.id,
    });

    expect(found?.id).toBe(parseId);
  });

  /**
   * ⚠⚠ THE CROSS-TENANT ASSERTION. A real `parseId` presented with somebody else's company is
   * NOT FOUND — not a 403, not a row: the caller has no way to learn the id exists.
   */
  it('returns undefined for a DIFFERENT companyId (cross-tenant is not-found)', async () => {
    const { user, parseId } = await seedPendingParse();
    const otherCompany = await companyFactory();

    expect(
      await projectBriefParsesRepository.findForOwner({
        parseId,
        companyId: otherCompany.id,
        requestedByUserId: user.id,
      })
    ).toBeUndefined();
  });

  /** The other half: a colleague inside the SAME company still cannot read your parse. */
  it('returns undefined for a DIFFERENT requestedByUserId', async () => {
    const { company, parseId } = await seedPendingParse();
    const colleague = await userFactory();

    expect(
      await projectBriefParsesRepository.findForOwner({
        parseId,
        companyId: company.id,
        requestedByUserId: colleague.id,
      })
    ).toBeUndefined();
  });
});

describe('projectBriefParsesRepository.findForRequester — §12 GATE 5', () => {
  it('returns the row for the requester', async () => {
    const { user, parseId } = await seedPendingParse();

    const found = await projectBriefParsesRepository.findForRequester({
      parseId,
      requestedByUserId: user.id,
    });

    expect(found?.id).toBe(parseId);
  });

  it('returns undefined for any other user — the API route has no companyId to fall back on', async () => {
    const { parseId } = await seedPendingParse();
    const stranger = await userFactory();

    expect(
      await projectBriefParsesRepository.findForRequester({
        parseId,
        requestedByUserId: stranger.id,
      })
    ).toBeUndefined();
  });
});

describe('projectBriefParsesRepository.markSucceeded', () => {
  it('stamps completed_at, the result and the audit/usage columns', async () => {
    const { parseId } = await seedPendingParse();
    const result = parseResult();

    const updated = await projectBriefParsesRepository.markSucceeded({
      parseId,
      result,
      audit: AUDIT,
      usage: USAGE,
    });

    expect(updated?.completedAt).toBeInstanceOf(Date);
    expect(updated?.result).toEqual(result);
    expect(updated?.failureReason).toBeNull();
    expect(updated?.modelId).toBe(AUDIT.modelId);
    expect(updated?.modelVersion).toBe(AUDIT.modelVersion);
    expect(updated?.promptId).toBe(AUDIT.promptId);
    expect(updated?.promptVersion).toBe(AUDIT.promptVersion);
    expect(updated?.inputTokens).toBe(USAGE.inputTokens);
    expect(updated?.outputTokens).toBe(USAGE.outputTokens);
    expect(updated === undefined ? null : toProjectBriefParseState(updated)).toEqual({
      state: 'succeeded',
      row: updated,
      result,
    });
  });

  /** ⚠ THE CAS. A redelivered job must not overwrite the answer the client is already reading. */
  it('a SECOND call returns undefined and does not mutate the row', async () => {
    const { parseId } = await seedPendingParse();
    const first = parseResult({ title: 'The first answer' });

    const won = await projectBriefParsesRepository.markSucceeded({
      parseId,
      result: first,
      audit: AUDIT,
      usage: USAGE,
    });
    const lost = await projectBriefParsesRepository.markSucceeded({
      parseId,
      result: parseResult({ title: 'A LATER, DIFFERENT answer' }),
      audit: { ...AUDIT, modelId: 'claude-sonnet-5' },
      usage: { inputTokens: 1, outputTokens: 1 },
    });

    expect(lost).toBeUndefined();

    const after = await projectBriefParsesRepository.findById(parseId);
    expect(after?.result).toEqual(first);
    expect(after?.modelId).toBe(AUDIT.modelId);
    expect(after?.inputTokens).toBe(USAGE.inputTokens);
    expect(after?.completedAt).toEqual(won?.completedAt);
  });

  it('returns undefined for an unknown id', async () => {
    expect(
      await projectBriefParsesRepository.markSucceeded({
        parseId: randomUUID(),
        result: parseResult(),
        audit: AUDIT,
        usage: USAGE,
      })
    ).toBeUndefined();
  });
});

describe('projectBriefParsesRepository.markFailed', () => {
  it('stamps completed_at and a FIXED failure literal, with no audit when the model was never reached', async () => {
    const { parseId } = await seedPendingParse();

    const updated = await projectBriefParsesRepository.markFailed({
      parseId,
      failureReason: 'enqueue_failed',
    });

    expect(updated?.completedAt).toBeInstanceOf(Date);
    expect(updated?.failureReason).toBe('enqueue_failed');
    expect(updated?.result).toBeNull();
    expect(updated?.modelId).toBeNull();
    expect(updated?.inputTokens).toBeNull();
    expect(updated === undefined ? null : toProjectBriefParseState(updated)).toEqual({
      state: 'failed',
      row: updated,
      failureReason: 'enqueue_failed',
    });
  });

  it('records audit + usage when the model WAS reached (a truncated answer still cost tokens)', async () => {
    const { parseId } = await seedPendingParse();

    const updated = await projectBriefParsesRepository.markFailed({
      parseId,
      failureReason: 'truncated',
      audit: AUDIT,
      usage: USAGE,
    });

    expect(updated?.failureReason).toBe('truncated');
    expect(updated?.modelId).toBe(AUDIT.modelId);
    expect(updated?.outputTokens).toBe(USAGE.outputTokens);
  });

  /** Terminal is terminal in BOTH directions: a late failure cannot un-succeed a parse. */
  it('after markSucceeded returns undefined and leaves the success standing', async () => {
    const { parseId } = await seedPendingParse();
    const result = parseResult();
    await projectBriefParsesRepository.markSucceeded({
      parseId,
      result,
      audit: AUDIT,
      usage: USAGE,
    });

    expect(
      await projectBriefParsesRepository.markFailed({ parseId, failureReason: 'unknown' })
    ).toBeUndefined();

    const after = await projectBriefParsesRepository.findById(parseId);
    expect(after?.result).toEqual(result);
    expect(after?.failureReason).toBeNull();
  });
});

describe('projectBriefParsesRepository.countCreatedSince', () => {
  it('counts only THIS user, only inside the window, only live rows', async () => {
    const { user, company } = await seedOwner();
    const otherUser = await userFactory();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const first = await projectBriefParsesRepository.create({
      companyId: company.id,
      requestedByUserId: user.id,
      sourceDocuments: sourceDocuments(),
    });
    await projectBriefParsesRepository.create({
      companyId: company.id,
      requestedByUserId: user.id,
      sourceDocuments: sourceDocuments(),
    });
    // Another user's parse, in the same company — must not count toward this user's budget.
    await projectBriefParsesRepository.create({
      companyId: company.id,
      requestedByUserId: otherUser.id,
      sourceDocuments: sourceDocuments(),
    });
    // This user's parse from BEFORE the window. `created_at` is set explicitly because the
    // column defaults to the TRANSACTION timestamp, which every row in this test shares.
    await db.insert(projectBriefParses).values({
      companyId: company.id,
      requestedByUserId: user.id,
      sourceDocuments: sourceDocuments(),
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });

    expect(
      await projectBriefParsesRepository.countCreatedSince({
        requestedByUserId: user.id,
        since: oneHourAgo,
      })
    ).toBe(2);

    await db
      .update(projectBriefParses)
      .set({ deletedAt: new Date() })
      .where(eq(projectBriefParses.id, first.id));

    expect(
      await projectBriefParsesRepository.countCreatedSince({
        requestedByUserId: user.id,
        since: oneHourAgo,
      })
    ).toBe(1);
  });

  it('returns 0 for a user with no parses', async () => {
    const stranger = await userFactory();

    expect(
      await projectBriefParsesRepository.countCreatedSince({
        requestedByUserId: stranger.id,
        since: new Date(Date.now() - 60 * 60 * 1000),
      })
    ).toBe(0);
  });
});

describe('soft delete', () => {
  it('hides the row from every read, and from the CAS writes', async () => {
    const { user, company, parseId } = await seedPendingParse();
    await db
      .update(projectBriefParses)
      .set({ deletedAt: new Date() })
      .where(eq(projectBriefParses.id, parseId));

    expect(await projectBriefParsesRepository.findById(parseId)).toBeUndefined();
    expect(
      await projectBriefParsesRepository.findForOwner({
        parseId,
        companyId: company.id,
        requestedByUserId: user.id,
      })
    ).toBeUndefined();
    expect(
      await projectBriefParsesRepository.findForRequester({ parseId, requestedByUserId: user.id })
    ).toBeUndefined();
    expect(
      await projectBriefParsesRepository.markSucceeded({
        parseId,
        result: parseResult(),
        audit: AUDIT,
        usage: USAGE,
      })
    ).toBeUndefined();
    expect(
      await projectBriefParsesRepository.markFailed({ parseId, failureReason: 'unknown' })
    ).toBeUndefined();
  });
});

describe('project_brief_parses CHECK constraints', () => {
  /**
   * ⚠ EACH PROBE RUNS IN ITS OWN `it()` AND ITS OWN SAVEPOINT. A raw failed statement on the
   * outer per-test transaction would abort it, and every later statement would answer 25P02
   * instead of the 23514 under test.
   */
  it('rejects a row that is BOTH succeeded and failed (single_outcome)', async () => {
    const { user, company } = await seedOwner();

    await expectConstraintViolation('23514', (tx) =>
      tx.insert(projectBriefParses).values({
        companyId: company.id,
        requestedByUserId: user.id,
        sourceDocuments: sourceDocuments(),
        result: parseResult(),
        failureReason: 'unknown',
        completedAt: new Date(),
      })
    );
  });

  it('rejects completion with NO outcome (completion_carries_an_outcome)', async () => {
    const { parseId } = await seedPendingParse();

    await expectConstraintViolation('23514', (tx) =>
      tx
        .update(projectBriefParses)
        .set({ completedAt: new Date() })
        .where(eq(projectBriefParses.id, parseId))
    );
  });

  /** The other direction of the ⇔: an outcome with no `completed_at` is equally impossible. */
  it('rejects an outcome with NO completion (completion_carries_an_outcome)', async () => {
    const { parseId } = await seedPendingParse();

    await expectConstraintViolation('23514', (tx) =>
      tx
        .update(projectBriefParses)
        .set({ failureReason: 'unreadable' })
        .where(eq(projectBriefParses.id, parseId))
    );
  });
});
