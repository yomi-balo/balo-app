import 'server-only';

import { sanitizeProjectHtml } from '@/lib/sanitize/project-html';
import { isDescriptionEmpty } from '@/components/balo/rich-text/plain-text';

/**
 * BAL-400 — sanitise the case-booking description before it EVER reaches
 * `caseEngagementsRepository.create`. `@balo/db` never sanitises
 * (`repositories/case-engagements.ts`, `schema/case-engagements.ts`) — BAL-400 is the FIRST
 * writer of `case_engagements.description`, so this IS the security boundary for that column.
 *
 * ⚠ REUSES `sanitizeProjectHtml`, DOES NOT MINT A THIRD ALLOW-LIST. `load-case.ts` already
 * sanitises this exact column with `sanitizeProjectHtml` ON READ; using a different allow-list
 * on WRITE would let the two disagree about what is legal, which is worse than either alone.
 * `sanitizeProposalOverviewHtml` is a deliberate SIBLING (project-html.ts), not a parameter —
 * the case column takes the narrower project list, same as it always has.
 *
 * ORDER IS LOAD-BEARING: sanitise, THEN assert real text content. A raw `<script>x</script>`
 * passes a naive non-empty check on the DIRTY string and sanitises to `''`, which would violate
 * `case_engagement_description_nonempty` at 23514 if it reached the repository. Checking the
 * SANITISED output is the only order that can't be fooled that way.
 *
 * The "real text" check is `isDescriptionEmpty` (`@/components/balo/rich-text/plain-text`) —
 * the SAME helper `submit-project-request.ts` already uses for this exact problem (an empty
 * Tiptap editor emits `<p></p>`, which a naive `.length > 0` check would wrongly accept). It is
 * built on `htmlToPlainText`'s linear, S5852-safe tag scan (`@balo/shared/notifications`) —
 * reusing it means this file never has to hand-roll a tag-strip regex at all, let alone the
 * `/<[^>]*>/g` ReDoS shape (memory `reference_sonarcloud_redos_tagstrip_regex`).
 */
export type SanitizeCaseDescriptionResult =
  | { readonly ok: true; readonly html: string }
  | { readonly ok: false };

export function sanitizeCaseDescription(dirty: string): SanitizeCaseDescriptionResult {
  const html = sanitizeProjectHtml(dirty);
  if (isDescriptionEmpty(html)) {
    return { ok: false };
  }
  return { ok: true, html };
}
