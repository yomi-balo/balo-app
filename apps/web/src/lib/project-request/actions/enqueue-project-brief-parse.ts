import 'server-only';

import { projectBriefParsesRepository } from '@balo/db';
import {
  MAX_PARSES_PER_HOUR,
  type ProjectBriefParseSourceDocument,
} from '@balo/shared/project-requests';
import { postBaloApiJson } from '@/lib/api/balo-api-client';
import { log } from '@/lib/logging';

const ONE_HOUR_MS = 60 * 60 * 1000;

export interface StartProjectBriefParseResult {
  success: boolean;
  parseId?: string;
  error?: string;
}

/**
 * Everything `CreateProjectBriefParseInput` needs beyond `companyId`/`requestedByUserId` —
 * i.e. exactly its discriminated `source` arm, restated rather than `Omit<>`'d off
 * `CreateProjectBriefParseInput`: `Omit` over an intersection-with-a-union collapses to the
 * two arms' COMMON keys (there are none), erasing the discriminant entirely. Both start
 * actions resolve this themselves (the documents arm after key validation + the byte cap, the
 * case arm after case authorization) and hand it to {@link enqueueProjectBriefParse} unchanged.
 */
export type EnqueueProjectBriefParseSource =
  | { source: 'documents'; sourceDocuments: readonly ProjectBriefParseSourceDocument[] }
  | { source: 'case'; sourceEngagementId: string };

export interface EnqueueProjectBriefParseInput {
  companyId: string;
  userId: string;
  source: EnqueueProjectBriefParseSource;
  /** Extra fields folded into both the success and failure log payloads — never an r2Key. */
  logContext: Record<string, unknown>;
}

const GENERIC_ERROR = 'Something went wrong generating your brief. Your files are still attached.';

/** The api answers `{ enqueued: true }` on success — nothing else is read from the body. */
function parseEnqueueResponse(parsed: Record<string, unknown>): { enqueued: true } | null {
  return parsed['enqueued'] === true ? { enqueued: true } : null;
}

/**
 * BAL-254 / BAL-589 — the shared tail of every brief-parse start: the hourly rate limit, the
 * `project_brief_parses` row, the api enqueue hop, and the failure/success logs. Neither start
 * action's SOURCE-SPECIFIC gate lives here — the documents arm's key validation
 * (`isSessionOwnedProjectDocumentKey`) and byte cap stay in `start-project-brief-parse.ts`, and
 * the case arm's `authorizeClientCaseMutation` + company check stay in
 * `cases/[engagementId]/_actions/start-case-brief-parse.ts` — because each gate's authority is
 * specific to its own source and this module has no session or case to check either against.
 *
 * A case source shares the same {@link MAX_PARSES_PER_HOUR} budget as a documents source (D6) —
 * one counter, keyed by `requestedByUserId` alone, regardless of which arm created the row.
 */
export async function enqueueProjectBriefParse(
  input: EnqueueProjectBriefParseInput
): Promise<StartProjectBriefParseResult> {
  const { companyId, userId, source, logContext } = input;

  const since = new Date(Date.now() - ONE_HOUR_MS);
  const recentCount = await projectBriefParsesRepository.countCreatedSince({
    requestedByUserId: userId,
    since,
  });
  if (recentCount >= MAX_PARSES_PER_HOUR) {
    return {
      success: false,
      error:
        "You've generated a lot of briefs in the last hour — give it a few minutes and try again.",
    };
  }

  const row =
    source.source === 'documents'
      ? await projectBriefParsesRepository.create({
          companyId,
          requestedByUserId: userId,
          source: 'documents',
          sourceDocuments: source.sourceDocuments,
        })
      : await projectBriefParsesRepository.create({
          companyId,
          requestedByUserId: userId,
          source: 'case',
          sourceEngagementId: source.sourceEngagementId,
        });

  const result = await postBaloApiJson(
    '/project-briefs/parse',
    { parseId: row.id },
    parseEnqueueResponse,
    'project brief parse'
  );

  if (!result.ok) {
    await projectBriefParsesRepository.markFailed({
      parseId: row.id,
      failureReason: 'enqueue_failed',
    });
    log.error('Project brief parse enqueue failed', {
      userId,
      companyId,
      parseId: row.id,
      status: result.status,
      code: result.code,
      ...logContext,
    });
    return { success: false, error: GENERIC_ERROR };
  }

  log.info('Project brief parse started', {
    userId,
    companyId,
    parseId: row.id,
    ...logContext,
  });

  return { success: true, parseId: row.id };
}
