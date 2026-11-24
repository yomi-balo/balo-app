/**
 * One numbered clause. Its number is derived from its position (see `clauseLabel`), never typed.
 * `text` may contain `{{clause:<id>}}` tokens, which `resolveClauseRefs` replaces with the number
 * of the clause carrying that `id`.
 */
export interface TermsNode {
  /** Required when the clause is referenced by a token, or carries a `draft` marker. */
  id?: string;
  text: string;
  children?: readonly TermsNode[];
  /** A trailing paragraph that renders after the sub-clauses. */
  after?: string;
  /** Drafted for Balo rather than ported from the published terms. The renderer never reads it. */
  draft?: true;
}

export interface TermsSection {
  id: string;
  title: string;
  /** Unnumbered paragraphs between the heading and clause 1, e.g. the definitions in section 1. */
  intro?: readonly string[];
  clauses: readonly TermsNode[];
  /** Drafted for Balo rather than ported from the published terms. The renderer never reads it. */
  draft?: true;
}

const ROMAN_NUMERALS = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x'] as const;

/**
 * The visible number of a clause from its 1-based position path
 * (`[section, clause, subclause, item, subitem]`): `3`, `3.7`, `3.7.1`, `(a)`, `ii.`.
 */
export function clauseLabel(path: readonly number[]): string {
  const [last] = path.slice(-1);
  if (last === undefined) {
    throw new RangeError('A clause path needs at least one position');
  }
  switch (path.length) {
    case 1:
    case 2:
    case 3:
      return path.join('.');
    case 4: {
      if (last < 1 || last > 26) {
        throw new RangeError(`No letter for position ${last}`);
      }
      return `(${String.fromCodePoint(96 + last)})`;
    }
    case 5: {
      const numeral = ROMAN_NUMERALS[last - 1];
      if (numeral === undefined) {
        throw new RangeError(`No roman numeral for position ${last}`);
      }
      return `${numeral}.`;
    }
    default:
      throw new RangeError(`Unsupported clause depth ${path.length}`);
  }
}

function indexNodes(
  nodes: readonly TermsNode[],
  parentPath: readonly number[],
  index: Map<string, string>
): void {
  nodes.forEach((node, position) => {
    const path = [...parentPath, position + 1];
    if (node.id !== undefined) {
      index.set(node.id, clauseLabel(path));
    }
    if (node.children) {
      indexNodes(node.children, path, index);
    }
  });
}

/** Maps every section id and clause id to its visible number. */
export function buildClauseIndex(sections: readonly TermsSection[]): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  sections.forEach((section, position) => {
    const path = [position + 1];
    index.set(section.id, clauseLabel(path));
    indexNodes(section.clauses, path, index);
  });
  return index;
}

/** Matches a `{{clause:<id>}}` token in clause text. */
export const CLAUSE_TOKEN = /\{\{clause:([a-z0-9.-]+)\}\}/g;

/** Replaces each `{{clause:<id>}}` token with the number of that clause. Throws on an unknown id. */
export function resolveClauseRefs(text: string, index: ReadonlyMap<string, string>): string {
  return text.replaceAll(CLAUSE_TOKEN, (_token, id: string) => {
    const label = index.get(id);
    if (label === undefined) {
      throw new Error(`Unknown clause reference: ${id}`);
    }
    return label;
  });
}

export interface EmphasisRun {
  text: string;
  emphasis: 'none' | 'bold' | 'italic';
}

/**
 * Splits `**bold**` and `*italic*` markers into runs. Markers are the published document's own
 * formatting. Throws on an unclosed marker, so a stray asterisk can never print.
 */
export function splitEmphasis(text: string): readonly EmphasisRun[] {
  const runs: EmphasisRun[] = [];
  let plain = '';
  let position = 0;
  const flush = (): void => {
    if (plain !== '') {
      runs.push({ text: plain, emphasis: 'none' });
      plain = '';
    }
  };
  while (position < text.length) {
    if (text[position] !== '*') {
      plain += text[position];
      position += 1;
      continue;
    }
    const marker = text.startsWith('**', position) ? '**' : '*';
    const close = text.indexOf(marker, position + marker.length);
    if (close === -1) {
      throw new Error(`Unclosed emphasis marker in: ${text}`);
    }
    const inner = text.slice(position + marker.length, close);
    if (inner === '') {
      throw new Error(`Empty emphasis marker in: ${text}`);
    }
    flush();
    runs.push({ text: inner, emphasis: marker === '**' ? 'bold' : 'italic' });
    position = close + marker.length;
  }
  flush();
  return runs;
}

const TERMS_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

/** An ISO date as a long date, e.g. '2025-07-23' becomes "23 July 2025". */
export function formatTermsDate(isoDate: string): string {
  return TERMS_DATE_FORMAT.format(new Date(`${isoDate}T00:00:00Z`));
}
