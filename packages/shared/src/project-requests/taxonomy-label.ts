/**
 * BAL-592 — THE ONE definition of "the same taxonomy label".
 *
 * A model-reported product label (or a humanised slug that missed the taxonomy) is resolved to a
 * product id ONLY by an exact lookup of this normalised form against Balo-owned rows: active
 * product names and `product_aliases` in the same vertical. Two consumers, one definition:
 *  - `apps/api`'s brief-parse resolver keys its lookup index with it;
 *  - `packages/db`'s seed-integrity test asserts that no seeded alias collides with another alias
 *    or with a product name under it.
 * A second, subtly different normaliser in either place would let the integrity test pass while
 * the resolver silently treats two rows as one (or one row as two).
 *
 * The rules, in order:
 *  1. Unicode NFKC, then lowercase — full-width letters, NBSP and other compatibility spaces fold
 *     to their plain forms.
 *  2. A bounded left-to-right scan of at most {@link MAX_TAXONOMY_LABEL_SCAN} code points: runs of
 *     whitespace collapse to one space, `&` becomes a space-separated `and` (so `Energy & Utilities`
 *     and `Energy&Utilities` agree), and leading/trailing whitespace is dropped.
 *  3. ONE leading `salesforce ` prefix is stripped. A bare `salesforce` is kept — the scan never
 *     leaves a trailing space, so a matched prefix always has text after it.
 *
 * No regex (SonarCloud S5852): whitespace is a `Set` lookup, the same shape as the slug humaniser
 * in the brief-parse taxonomy mapping. PURE.
 */

/** Upper bound on the code points the scan reads; the rest of an over-long label is ignored. */
export const MAX_TAXONOMY_LABEL_SCAN = 120;

const LABEL_WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

const SALESFORCE_PREFIX = 'salesforce ';

export function normalizeTaxonomyLabel(label: string): string {
  const folded = label.normalize('NFKC').toLowerCase();

  let out = '';
  let pendingSpace = false;
  let scanned = 0;

  const emit = (token: string): void => {
    if (pendingSpace && out.length > 0) out += ' ';
    pendingSpace = false;
    out += token;
  };

  for (const char of folded) {
    if (scanned >= MAX_TAXONOMY_LABEL_SCAN) break;
    scanned += 1;

    if (LABEL_WHITESPACE.has(char)) {
      pendingSpace = true;
    } else if (char === '&') {
      pendingSpace = true;
      emit('and');
      pendingSpace = true;
    } else {
      emit(char);
    }
  }

  return out.startsWith(SALESFORCE_PREFIX) ? out.slice(SALESFORCE_PREFIX.length) : out;
}
