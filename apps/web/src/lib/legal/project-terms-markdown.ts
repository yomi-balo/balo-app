import {
  PROJECT_TERMS,
  PROJECT_TERMS_LAST_UPDATED_LINE,
  PROJECT_TERMS_TITLE,
} from './project-terms';
import { clauseLabel, type TermsNode } from './terms';

export const PROJECT_TERMS_MARKDOWN_HEADER =
  '<!-- Generated from apps/web/src/lib/legal/project-terms.ts by pnpm --filter web legal:publish. Do not edit. -->';

/** The lines of one clause and its descendants. Depth 2 is flush, depth 3 a bullet, 4 a nested one. */
function clauseLines(node: TermsNode, path: readonly number[]): string[] {
  const label = clauseLabel(path);
  const line = `${label} ${node.text}`;
  const own = path.length === 2 ? line : `${'  '.repeat(path.length - 3)}- ${line}`;
  const nested = (node.children ?? []).flatMap((child, position) =>
    clauseLines(child, [...path, position + 1])
  );
  return [own, ...nested];
}

/**
 * The current agreement as Markdown, one line per clause (number, wording and `**`/`*` markers).
 * Labels come from clause position, which reproduces the published document's own numbering.
 * Committed as `docs/legal/project-terms.md` for the diff the approver reads.
 */
export function renderProjectTermsMarkdown(): string {
  const blocks: string[] = [
    PROJECT_TERMS_MARKDOWN_HEADER,
    `# ${PROJECT_TERMS_TITLE}`,
    PROJECT_TERMS_LAST_UPDATED_LINE,
  ];
  PROJECT_TERMS.forEach((section, sectionPosition) => {
    blocks.push(`## ${sectionPosition + 1}. ${section.title}`, ...(section.intro ?? []));
    section.clauses.forEach((clause, position) => {
      blocks.push(clauseLines(clause, [sectionPosition + 1, position + 1]).join('\n'));
    });
  });
  return `${blocks.join('\n\n')}\n`;
}
