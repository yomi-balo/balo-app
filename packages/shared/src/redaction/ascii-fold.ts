/**
 * Fold ONLY `A`–`Z` to lower case, leaving every other code unit — including all non-ASCII —
 * byte-for-byte identical.
 *
 * ⚠ THE POINT IS THE LENGTH INVARIANT, not the casing. `String.prototype.toLowerCase` is
 * locale- and Unicode-aware and can CHANGE THE LENGTH of a string (`'İ'` folds to two code
 * units), which would silently desynchronise an index found in the folded copy from the
 * original it is sliced out of — turning a redaction into a corruption. A strict A–Z fold is
 * one-to-one on code units, so `toAsciiLowerCase(v).length === v.length` always holds and an
 * index is interchangeable between the two.
 *
 * ⚠⚠ FIX ROUND 2 G1 — this holds for EVERY input this module ever folds, including a
 * percent-encoded needle (`%5f`, `%2f`, `%252f`, …): the loop below has no awareness of `%`
 * as a delimiter or escape character, it is a per-code-unit A–Z table lookup with no
 * lookahead/lookbehind, so an encoded sequence is folded exactly like any other run of
 * characters — one input code unit in, one output code unit out, always. There is no
 * encoded form for which folded and raw length can diverge; the invariant is unconditional,
 * not a property that happens to hold for the shapes this module has tried so far.
 *
 * Deliberately no regex, matching the rest of `./index.ts`: attacker-controlled URLs must not
 * meet a pattern with a super-linear worst case (SonarCloud S5852).
 *
 * ⚠ EXTRACTED TO ITS OWN MODULE (FIX ROUND 2 G1) so a test can `vi.spyOn` the import binding
 * and assert how many times `redactSensitivePath` folds a string — the whole point of the G1
 * fix is that this is now O(1) per `redactSensitivePath` call (was: O(occurrences)), and a
 * call-count assertion is the deterministic, load-immune way to pin that. A same-file private
 * function cannot be spied on from a test — internal calls do not go through the module's
 * export object — so it would not have caught the regression this fix corrects.
 */
const ASCII_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ASCII_LOWER = 'abcdefghijklmnopqrstuvwxyz';

export function toAsciiLowerCase(value: string): string {
  let folded = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i);
    // Table lookup rather than arithmetic on char codes. SonarCloud pushes `charCodeAt` →
    // `codePointAt` (S7728) as a blanket ES2015 preference, but that swap would be WRONG
    // here and silently so: this loop walks CODE UNITS on purpose, and `codePointAt` at a
    // high surrogate returns the combined code point, breaking the one-to-one index
    // correspondence that `toAsciiLowerCase(v).length === v.length` depends on. Indexing a
    // 26-char table sidesteps the whole argument — no char codes, same guarantee.
    const upperIndex = ASCII_UPPER.indexOf(char);
    folded += upperIndex === -1 ? char : ASCII_LOWER.charAt(upperIndex);
  }
  return folded;
}
