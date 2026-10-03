import type { ProjectBriefFailureReason } from '@balo/shared/project-requests';

/**
 * A classified, terminal failure — carries the closed `ProjectBriefFailureReason` literal the
 * worker will persist via `markFailed`. `cause` (when present) is logged, never persisted.
 *
 * Lives in its own module rather than `parse.ts`: `parse.ts` imports `loadCaseSource` from
 * `case-source.ts`, and `case-source.ts` throws this error, so declaring the class in `parse.ts`
 * would make the two modules import each other. `parse.ts` re-exports it so every existing
 * importer keeps working unchanged.
 */
export class ProjectBriefParseError extends Error {
  constructor(
    readonly reason: ProjectBriefFailureReason,
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ProjectBriefParseError';
  }
}
