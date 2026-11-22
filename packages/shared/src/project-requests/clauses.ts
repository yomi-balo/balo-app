/**
 * Proposal clauses: the three typed, ordered, plain-text lists an expert attaches to a proposal
 * (assumptions, exclusions, additional terms). One definition of the kinds, the caps and the
 * text clean-up, shared by `@balo/db` (the pgEnum is pinned to this tuple), the save Server
 * Actions (which validate with it) and the composer (which edits with it).
 *
 * PURE. No I/O, no clock, no `server-only`.
 */

/** The three lists. The order is the pgEnum's order and the order the document renders them in. */
export const PROPOSAL_CLAUSE_KINDS = ['assumption', 'exclusion', 'additional_term'] as const;

/** @see PROPOSAL_CLAUSE_KINDS */
export type ProposalClauseKind = (typeof PROPOSAL_CLAUSE_KINDS)[number];

/** The most items one list can hold. */
export const PROPOSAL_CLAUSE_MAX_ITEMS = 20;

/** The most characters one item can hold, after {@link normalizeClauseBody}. */
export const PROPOSAL_CLAUSE_MAX_CHARS = 500;

/** The length from which the editor starts showing an item's character counter. */
export const PROPOSAL_CLAUSE_COUNT_FROM = 420;

/**
 * Collapse every line break (and the whitespace around it) to one space, then trim. An item is
 * one line of plain text, so a pasted paragraph becomes a single run rather than a hidden
 * multi-line value. Written as a split rather than a `\s*\n+\s*` regex so it stays linear on a
 * long whitespace run.
 */
export function normalizeClauseBody(raw: string): string {
  return raw
    .split('\n')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join(' ');
}

/** A leading list marker: a dash or bullet, or a number followed by `.` or `)`. */
const LIST_MARKER_RE = /^\s*(?:[-•*–—]|\d+[.)])\s+/;

/** Drop one leading list marker ("- ", "• ", "1. ", "2) ", "— ") and normalise what remains. */
export function stripListMarker(line: string): string {
  return normalizeClauseBody(line.replace(LIST_MARKER_RE, ''));
}

/** Split pasted text into one body per non-blank line, markers stripped. */
export function splitPastedClauses(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(stripListMarker)
    .filter((body) => body.length > 0);
}

/**
 * A rate or price typed into a list item. The client would see it without Balo's margin, so the
 * editor warns. Inputs are capped at {@link PROPOSAL_CLAUSE_MAX_CHARS} characters.
 */
const AMOUNT_RE =
  /[$€£]\s?\d|\b\d[\d,.]*\s?(?:aud|usd|nzd|eur|gbp|dollars?)\b|\/\s?h(?:ou)?r\b|\bper (?:hour|day)\b/i;

/** Whether an item reads like it names a price or a rate. */
export function clauseMentionsAmount(body: string): boolean {
  return AMOUNT_RE.test(body);
}

/** Split a proposal's clause rows into the three display lists, keeping the input order. */
export function groupClauseBodies(rows: readonly { kind: ProposalClauseKind; body: string }[]): {
  assumptions: string[];
  exclusions: string[];
  additionalTerms: string[];
} {
  const assumptions: string[] = [];
  const exclusions: string[] = [];
  const additionalTerms: string[] = [];
  for (const row of rows) {
    if (row.kind === 'assumption') assumptions.push(row.body);
    else if (row.kind === 'exclusion') exclusions.push(row.body);
    else additionalTerms.push(row.body);
  }
  return { assumptions, exclusions, additionalTerms };
}
