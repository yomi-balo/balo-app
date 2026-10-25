import { describe, expect, it } from 'vitest';
import {
  DRAFT_DEADLINE_MS,
  MAX_PROPOSAL_DRAFTS_PER_HOUR,
  PROPOSAL_DRAFT_FAILURE_REASONS,
  PROPOSAL_DRAFT_MAX_ACCEPTANCE_CRITERIA,
  PROPOSAL_DRAFT_MAX_DESCRIPTION_HTML,
  PROPOSAL_DRAFT_MAX_MILESTONES,
  PROPOSAL_DRAFT_MAX_OVERVIEW_HTML,
  PROPOSAL_DRAFT_MAX_POLLS,
  PROPOSAL_DRAFT_MAX_TITLE,
  PROPOSAL_DRAFT_MIN_MILESTONES,
  PROPOSAL_DRAFT_POLL_INTERVAL_MS,
} from './proposal-draft';
import * as projectRequests from './index';

/**
 * The composer's save bounds, restated from `apps/web/.../_actions/proposal-schema.ts`
 * (`overview`, `milestoneSchema.title`, `.descriptionHtml`, `.acceptanceCriteria`).
 * `@balo/shared` cannot import from `apps/web`, so they are literals here; a draft bound above
 * any of them would apply a draft the composer's own autosave then refuses.
 */
const COMPOSER_SAVE_BOUNDS = {
  overview: 50_000,
  title: 200,
  descriptionHtml: 20_000,
  acceptanceCriteria: 2_000,
} as const;

describe('proposal-draft timing', () => {
  it('gives up polling before a pending row is derived as failed', () => {
    expect(PROPOSAL_DRAFT_POLL_INTERVAL_MS * PROPOSAL_DRAFT_MAX_POLLS).toBeLessThan(
      DRAFT_DEADLINE_MS
    );
  });

  it('pins the decided values', () => {
    expect(DRAFT_DEADLINE_MS).toBe(90_000);
    expect(MAX_PROPOSAL_DRAFTS_PER_HOUR).toBe(20);
  });
});

describe('proposal-draft output bounds', () => {
  it('drafts two to five milestones', () => {
    expect(PROPOSAL_DRAFT_MIN_MILESTONES).toBe(2);
    expect(PROPOSAL_DRAFT_MAX_MILESTONES).toBe(5);
  });

  it('never exceeds a composer save bound', () => {
    expect(PROPOSAL_DRAFT_MAX_OVERVIEW_HTML).toBeLessThanOrEqual(COMPOSER_SAVE_BOUNDS.overview);
    expect(PROPOSAL_DRAFT_MAX_TITLE).toBeLessThanOrEqual(COMPOSER_SAVE_BOUNDS.title);
    expect(PROPOSAL_DRAFT_MAX_DESCRIPTION_HTML).toBeLessThanOrEqual(
      COMPOSER_SAVE_BOUNDS.descriptionHtml
    );
    expect(PROPOSAL_DRAFT_MAX_ACCEPTANCE_CRITERIA).toBeLessThanOrEqual(
      COMPOSER_SAVE_BOUNDS.acceptanceCriteria
    );
  });
});

describe('PROPOSAL_DRAFT_FAILURE_REASONS', () => {
  it('is the closed stored vocabulary', () => {
    expect(PROPOSAL_DRAFT_FAILURE_REASONS).toEqual([
      'enqueue_failed',
      'model_unavailable',
      'invalid_output',
      'truncated',
      'empty_output',
      'source_unavailable',
      'deadline_exceeded',
      'unknown',
    ]);
  });
});

describe('@balo/shared/project-requests barrel', () => {
  it('re-exports the proposal-draft contract', () => {
    expect(projectRequests.DRAFT_DEADLINE_MS).toBe(DRAFT_DEADLINE_MS);
    expect(projectRequests.PROPOSAL_DRAFT_FAILURE_REASONS).toBe(PROPOSAL_DRAFT_FAILURE_REASONS);
  });
});
