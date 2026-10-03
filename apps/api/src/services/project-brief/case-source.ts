import { caseEngagementsRepository, expertsRepository, type ProjectBriefParse } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { buildCaseHistoryInput, renderCaseHistory } from './case-history.js';
import { CASE_HISTORY_MAX_CHARS } from './config.js';
import { ProjectBriefParseError } from './parse.js';

const log = createLogger('project-brief-case-source');

/** What `loadParseSource`'s case arm needs to render the from-case prompt. */
export interface CaseSource {
  readonly caseTitle: string;
  readonly historyText: string;
  readonly truncated: boolean;
  readonly messageCount: number;
  readonly transcriptCount: number;
}

/**
 * The worker's case gate plus the history build. Re-checks the case against the ROW's
 * `company_id` — never a payload, there is none — exactly as Gate 3 re-checks document keys for
 * the documents arm.
 *
 * Both open and closed cases are eligible; conversion never mutates the case.
 */
export async function loadCaseSource(row: ProjectBriefParse, parseId: string): Promise<CaseSource> {
  const engagementId = row.sourceEngagementId;
  if (engagementId === null) {
    // Unreachable through `loadParseSource` (it only calls this arm when the row carries a
    // case source), but `source_engagement_id` is nullable at the type level, so this keeps
    // the function total rather than relying on the caller alone.
    throw new ProjectBriefParseError('case_unavailable', 'Row carries no case source');
  }

  const caseRow = await caseEngagementsRepository.findByEngagementId(engagementId);
  if (caseRow?.companyId !== row.companyId) {
    log.warn({ parseId, caseId: engagementId }, 'Project brief parse — case gate failed');
    throw new ProjectBriefParseError('case_unavailable', 'The case is unavailable for this parse');
  }

  const expertUserIds = await expertsRepository.findUserIdsByProfileIds([caseRow.expertProfileId]);

  const historyInput = await buildCaseHistoryInput({ engagementId, expertUserIds });
  if (historyInput.messages.length === 0 && historyInput.transcripts.length === 0) {
    log.warn({ parseId, caseId: engagementId }, 'Project brief parse — case has no history');
    throw new ProjectBriefParseError('no_case_history', 'The case has no messages or transcripts');
  }

  const { text: historyText, truncated } = renderCaseHistory(historyInput, CASE_HISTORY_MAX_CHARS);

  log.info(
    {
      parseId,
      caseId: engagementId,
      messageCount: historyInput.messages.length,
      transcriptCount: historyInput.transcripts.length,
      truncated,
    },
    'Case brief parse started'
  );

  return {
    caseTitle: caseRow.title,
    historyText,
    truncated,
    messageCount: historyInput.messages.length,
    transcriptCount: historyInput.transcripts.length,
  };
}
