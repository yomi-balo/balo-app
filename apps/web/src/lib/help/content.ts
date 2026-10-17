import 'server-only';

import type { HelpAudience } from '@/lib/analytics'; // TYPE-ONLY — erased; no posthog-js at runtime
import { HELP_CATEGORIES } from './categories';
import { HELP_GUIDES } from './generated/help-guides.generated';
import type { HelpCategoryGroup, HelpGuide, HelpGuideSummary } from './types';

function toSummary(guide: HelpGuide): HelpGuideSummary {
  const { slug, title, summary, audience } = guide;
  return { slug, title, summary, audience };
}

function byOrderThenTitle(a: HelpGuide, b: HelpGuide): number {
  return a.order - b.order || a.title.localeCompare(b.title);
}

export interface HelpContent {
  /** Categories in registry order. A category with no published guide is dropped. */
  listCategories(audience: HelpAudience): readonly HelpCategoryGroup[];
  findGuide(slug: string): HelpGuide | undefined;
  /** Summaries in input order; unknown slugs are dropped. */
  findSummaries(slugs: readonly string[]): readonly HelpGuideSummary[];
}

export function createHelpContent(guides: readonly HelpGuide[]): HelpContent {
  return {
    listCategories(audience) {
      return HELP_CATEGORIES[audience].flatMap((category) => {
        const inCategory = guides
          .filter((guide) => guide.category[audience] === category.id)
          .sort(byOrderThenTitle)
          .map(toSummary);
        return inCategory.length === 0 ? [] : [{ ...category, guides: inCategory }];
      });
    },
    findGuide(slug) {
      return guides.find((guide) => guide.slug === slug);
    },
    findSummaries(slugs) {
      return slugs.flatMap((slug) => {
        const guide = guides.find((candidate) => candidate.slug === slug);
        return guide === undefined ? [] : [toSummary(guide)];
      });
    },
  };
}

export const helpContent: HelpContent = createHelpContent(HELP_GUIDES);
