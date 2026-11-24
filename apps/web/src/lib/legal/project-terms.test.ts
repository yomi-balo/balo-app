import { describe, expect, it } from 'vitest';
import {
  PROJECT_TERMS,
  PROJECT_TERMS_LAST_UPDATED_LINE,
  PROJECT_TERMS_VERSION,
} from './project-terms';
import {
  buildClauseIndex,
  clauseLabel,
  formatTermsDate,
  splitEmphasis,
  type TermsNode,
} from './terms';

function walk(
  nodes: readonly TermsNode[],
  path: readonly number[],
  visit: (n: TermsNode, p: number[]) => void
): void {
  nodes.forEach((node, position) => {
    const next = [...path, position + 1];
    visit(node, next);
    walk(node.children ?? [], next, visit);
  });
}

const ALL_TEXT: string[] = [];
PROJECT_TERMS.forEach((section, i) => {
  ALL_TEXT.push(section.title, ...(section.intro ?? []));
  walk(section.clauses, [i + 1], (node, path) => {
    expect(clauseLabel(path)).toBeTruthy();
    ALL_TEXT.push(node.text);
  });
});

describe('project terms', () => {
  it('has 19 sections with titles and clauses', () => {
    expect(PROJECT_TERMS).toHaveLength(19);
    for (const s of PROJECT_TERMS) {
      expect(s.title).not.toBe('');
      expect(s.clauses.length).toBeGreaterThan(0);
    }
  });

  it('has no empty text and no clause tokens', () => {
    for (const t of ALL_TEXT) {
      expect(t.trim()).not.toBe('');
      expect(t).not.toContain('{{clause:');
    }
  });

  it('leaves no asterisk after emphasis is split', () => {
    for (const t of [...ALL_TEXT, PROJECT_TERMS_LAST_UPDATED_LINE]) {
      for (const run of splitEmphasis(t)) {
        expect(run.text).not.toContain('*');
      }
    }
  });

  it('uses no trailing `after` paragraph, which the PDF and Markdown renderers do not render', () => {
    PROJECT_TERMS.forEach((section, i) => {
      walk(section.clauses, [i + 1], (node) => {
        expect(node.after).toBeUndefined();
      });
    });
  });

  it('builds a clause index', () => {
    expect(buildClauseIndex(PROJECT_TERMS).get('definitions-and-interpretation')).toBe('1');
  });

  it('has an ISO version named by the Last Updated line', () => {
    expect(PROJECT_TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const named = PROJECT_TERMS_LAST_UPDATED_LINE.replace(/(\d{1,2})(?:st|nd|rd|th)/, '$1');
    expect(named).toContain(formatTermsDate(PROJECT_TERMS_VERSION));
  });

  it('opens section 1 with 9 intro paragraphs', () => {
    expect(PROJECT_TERMS[0]?.intro).toHaveLength(9);
  });
});
