'use server';
import 'server-only';

import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { projectBriefParsesRepository, toProjectBriefParseState } from '@balo/db';
import {
  MAX_BRIEF_DESCRIPTION_HTML_LENGTH,
  PARSE_DEADLINE_MS,
  narrowToProjectBriefFailureReason,
  type ProjectBriefFailureReason,
} from '@balo/shared/project-requests';
import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
import { loadProjectRequestTaxonomies } from '@/lib/project-request/load-project-taxonomy';
import { markdownToProjectHtml } from '@/lib/project-request/markdown-to-project-html';
import { log } from '@/lib/logging';

const getProjectBriefParseInputSchema = z.object({ parseId: z.string().uuid() });

export interface ProjectBriefDraftPatch {
  title: string;
  /** Converted + sanitised server-side — see D4. */
  descriptionHtml: string;
  /** Re-intersected against the LIVE taxonomy (D5's second gate). */
  tagIds: string[];
  productIds: string[];
  /** Display-only, component state ONLY — never persisted into `ProjectDraft`. */
  unmatchedTagLabels: string[];
  unmatchedProductLabels: string[];
}

export type ProjectBriefParsePollResult =
  | { status: 'pending' }
  | { status: 'failed'; failureReason: ProjectBriefFailureReason }
  | { status: 'succeeded'; draft: ProjectBriefDraftPatch };

/**
 * BAL-254 — poll a `project_brief_parses` row. ⚠⚠ §12 Gate 4: `findForOwner` puts BOTH
 * `companyId` and `requestedByUserId` in the WHERE, so a cross-tenant `parseId` is a not-found —
 * this action MUST NEVER distinguish "not yours" from "does not exist".
 */
export const getProjectBriefParseAction = withAuth(
  async (session, rawInput: unknown): Promise<ProjectBriefParsePollResult> => {
    const parsed = getProjectBriefParseInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      return { status: 'failed', failureReason: 'not_found' };
    }

    const row = await projectBriefParsesRepository.findForOwner({
      parseId: parsed.data.parseId,
      companyId: session.user.companyId,
      requestedByUserId: session.user.id,
    });
    if (row === undefined) {
      return { status: 'failed', failureReason: 'not_found' };
    }

    const state = toProjectBriefParseState(row);

    if (state.state === 'pending') {
      const isPastDeadline = Date.now() - row.createdAt.getTime() > PARSE_DEADLINE_MS;
      if (isPastDeadline) {
        // ⚠ DERIVED — never written (D3).
        return { status: 'failed', failureReason: 'timed_out' };
      }
      return { status: 'pending' };
    }

    if (state.state === 'failed') {
      return {
        status: 'failed',
        failureReason: narrowToProjectBriefFailureReason(state.failureReason) ?? 'unknown',
      };
    }

    // ── succeeded ──────────────────────────────────────────────────────────────────────────
    try {
      // ⚠⚠ D4 — this ordering (convert THEN sanitise) is the contract; a test pins it.
      const descriptionHtml = sanitizeProjectHtml(
        markdownToProjectHtml(state.result.descriptionMarkdown)
      );

      // ⚠⚠ BAL-254 W7 — THE HTML BOUND, MEASURED RATHER THAN ASSUMED. `MAX_BRIEF_MARKDOWN_LENGTH`
      // (8000) was commented as "→ ≤20000 HTML", which is not a property the conversion has:
      // escaping alone expands up to 5× (`&` → `&amp;`) before a single tag is added. The
      // consequence of being wrong is silent and terminal — the brief generates cleanly, prefills
      // the review step, and then `submitProjectRequestAction` rejects it on the `description`
      // max with no way for the user to tell what is too long. Refusing HERE means the failure
      // banner and Try again / Write it myself, which is a recoverable screen. Pathological in
      // practice; the row is untouched and still holds the real result.
      if (descriptionHtml.length > MAX_BRIEF_DESCRIPTION_HTML_LENGTH) {
        log.error('Project brief parse — converted HTML exceeds the submit cap', {
          userId: session.user.id,
          parseId: row.id,
          htmlLength: descriptionHtml.length,
          limit: MAX_BRIEF_DESCRIPTION_HTML_LENGTH,
        });
        return { status: 'failed', failureReason: 'invalid_output' };
      }

      const taxonomies = await loadProjectRequestTaxonomies();
      // ⚠⚠ FIX ROUND F17 — A TAXONOMY BLIP MUST NOT SILENTLY STRIP THE BRIEF. That loader never
      // throws: on any DB failure it returns EMPTY for both, and the intersection below would
      // then drop EVERY tag and product the model selected — handing the client a plausible
      // brief with no tags, no products, and nothing anywhere saying so. "Loaded and genuinely
      // empty" is a real state (a fresh vertical) and stays fine; "failed to load" is not, and
      // is what this branch refuses. The client gets the generic banner and can retry; the parse
      // row is untouched and still holds the real result.
      if (taxonomies.loadFailed) {
        log.error('Project brief parse — taxonomy load failed, refusing to deliver the draft', {
          userId: session.user.id,
          parseId: row.id,
        });
        return { status: 'failed', failureReason: 'unknown' };
      }

      const liveTagIds = new Set(
        taxonomies.tags.groups.flatMap((group) => group.items.map((item) => item.id))
      );
      const liveProductIds = new Set(
        taxonomies.products.groups.flatMap((group) => group.items.map((item) => item.id))
      );

      const tagIds = state.result.tagIds.filter((id) => liveTagIds.has(id));
      const productIds = state.result.productIds.filter((id) => liveProductIds.has(id));

      log.info('Project brief parse delivered', {
        userId: session.user.id,
        parseId: row.id,
        tagCount: tagIds.length,
        productCount: productIds.length,
        droppedTagCount: state.result.tagIds.length - tagIds.length,
        droppedProductCount: state.result.productIds.length - productIds.length,
      });

      return {
        status: 'succeeded',
        draft: {
          title: state.result.title,
          descriptionHtml,
          tagIds,
          productIds,
          unmatchedTagLabels: [...state.result.unmatchedTagLabels],
          unmatchedProductLabels: [...state.result.unmatchedProductLabels],
        },
      };
    } catch (error) {
      log.error('Project brief parse — failed to prepare the succeeded draft', {
        userId: session.user.id,
        parseId: row.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { status: 'failed', failureReason: 'unknown' };
    }
  }
);
