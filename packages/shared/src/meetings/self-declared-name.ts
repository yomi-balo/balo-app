/**
 * BAL-436 — the ONE definition of "is this text an email address?" and of "what is safe to
 * show a host as a self-declared name?".
 *
 * ── ⚠⚠ WHY THIS EXISTS AT ALL: THE CONCEALMENT IS FIELD-SCOPED ──────────────────────────
 *
 * `projectGuestForViewer`'s `link` arm strips `email`, `emailDomain` and `accessScope` and
 * refuses the `displayName`-falls-back-to-the-address rule, so no verified fact about the
 * address reaches a browser. **That closes exactly one column.** The neighbouring column is
 * `meeting_guests.name`, which an ANONYMOUS visitor types into the lobby knock, and which the
 * projector passes through verbatim to `displayName` — into the host's queue, into the
 * `Admit …` / `Deny …` accessible names, and (on a re-send) into a Balo-branded email.
 *
 * So a visitor who typed `dana.okoro@northwind.com` as their NAME defeats the concealment
 * through the next column along, and Ruling B's own argument against showing the address
 * ("showing it does not raise confidence honestly, it MANUFACTURES confidence") applies to
 * that string word for word. The scan therefore runs SERVER-SIDE, at the knock, before the
 * row is ever written.
 *
 * ── ⚠⚠ WHAT IS COVERED, AND WHAT IS DELIBERATELY NOT ────────────────────────────────────
 *
 * COVERED — the two spoofs that borrow Balo's OWN vocabulary, because those are the ones a
 * host cannot discount by reading:
 *   · an email address anywhere in the string → the whole name collapses to `Guest`;
 *   · a trust claim that impersonates this surface's own badge or the platform —
 *     `verified` / `unverified` / `official` / `balo`, and the check-mark / shield / lock
 *     glyphs the badge idiom uses — → the claim is removed and the rest of the name kept.
 *
 * ⚠ NOT COVERED, STATED RATHER THAN IMPLIED: an arbitrary ORGANISATIONAL claim
 * (`Dana Okoro (Northwind IT)`), a homoglyph or full-width look-alike of the words above, or
 * simply a plausible colleague's name. **Those are not solvable here and must not be
 * pretended away** — they are exactly what the UNVERIFIED badge and the queue disclosure
 * ("Balo hasn't checked who they are") exist to answer. The scan removes the claims that
 * would make the badge itself look wrong; it does not and cannot make a stranger's name true.
 *
 * ── ⚠ NO REGEX ON THE ADDRESS SCAN ──────────────────────────────────────────────────────
 *
 * The obvious pattern — `/[\w.-]+@[\w-]+\.[a-z]{2,}/i` — is a quantifier followed by a
 * rejecting suffix, which `regexp/no-super-linear-move` (the local half of SonarCloud's ReDoS
 * rule S5852) flags as quadratic. This input is ATTACKER-CONTROLLED and arrives on a PUBLIC,
 * unauthenticated route, so that is not a theoretical concern. The repo's own escape hatch is
 * a linear scan with no pattern engine behind it (`sanitizeMeetingFileName`, `_source-scan`,
 * `redactSensitivePath`), so that is what this is.
 *
 * PURE and dependency-free, so `apps/api`'s lobby route, `apps/web`'s test sweeps and any
 * future surface all reach ONE definition. A second copy is how a weakening ships unnoticed.
 */

function isAddressCharacter(character: string): boolean {
  return (
    (character >= 'a' && character <= 'z') ||
    (character >= 'A' && character <= 'Z') ||
    (character >= '0' && character <= '9') ||
    character === '.' ||
    character === '-' ||
    character === '_' ||
    character === '+'
  );
}

function isLetter(character: string): boolean {
  return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z');
}

/**
 * ⚠⚠ THE TLD MUST BE **LETTERS**, AND THAT IS NOT PEDANTRY — IT IS WHAT KEEPS THIS USABLE.
 *
 * A stack trace legitimately contains `@vitest+runner@4.0.18/node_modules/…`, and a rule of
 * "a dot with two characters after it" matches `4.0.18`. The first version of this scan did,
 * and the sweep failed on the test harness rather than on a leak — which is exactly how a
 * security assertion gets weakened or deleted instead of obeyed. A real tld is alphabetic.
 */
function hasAlphabeticTld(text: string, lastDot: number, end: number): boolean {
  if (lastDot === -1 || end - lastDot < 3) return false;
  for (let index = lastDot + 1; index < end; index += 1) {
    if (!isLetter(text.charAt(index))) return false;
  }
  return true;
}

/**
 * True when `text` holds something shaped like `local@domain.tld`.
 *
 * The scan walks every `@`, checks there is at least one address character immediately before
 * it, then walks forward collecting address characters and requires the run to end in a dot
 * plus an alphabetic tld of at least two letters. Provably O(n): each `@` is visited once and
 * the forward walk never revisits a character it has already consumed for the same `@`.
 *
 * ⚠ IT IS DELIBERATELY **LOOSE**, i.e. biased toward FALSE ALARMS. It only has to be right in
 * one direction: it must never miss a real address. A stray match on unusual prose collapses
 * one self-declared name to `Guest`, which is a cosmetic loss; a miss is a leak nobody sees.
 */
export function containsEmailAddress(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charAt(index) !== '@') continue;
    if (index === 0 || !isAddressCharacter(text.charAt(index - 1))) continue;

    let end = index + 1;
    let lastDot = -1;
    while (end < text.length && isAddressCharacter(text.charAt(end))) {
      if (text.charAt(end) === '.') lastDot = end;
      end += 1;
    }
    if (hasAlphabeticTld(text, lastDot, end)) return true;
  }
  return false;
}

/**
 * The name shown when nothing safe survives.
 *
 * ⚠ THE SAME STRING `projectGuestForViewer`'s `link` arm already falls back to, so a host sees
 * one vocabulary for "we know nothing about this person" rather than two.
 */
export const ANONYMOUS_GUEST_NAME = 'Guest';

/**
 * Code points whose whole communicative job is "this has been checked".
 *
 * ⚠ AN EXPLICIT, NARROW LIST OF CODE POINTS — never a range and never "all emoji". Stripping
 * a range would quietly delete unrelated characters from somebody's name, which is a worse
 * failure than leaving a glyph we did not anticipate: the badge and the disclosure are still
 * on the row either way.
 *
 * ⚠ U+FE0F (the emoji variation selector) is included because `✅` is frequently written
 * `✔️`, and dropping only the base glyph would leave a stray selector in the stored name.
 */
const TRUST_CODEPOINTS = new Set<number>([
  0x2705, // ✅ white heavy check mark
  0x2714, // ✔ heavy check mark
  0x2713, // ✓ check mark
  0x2611, // ☑ ballot box with check
  0x1f6e1, // 🛡 shield
  0x1f512, // 🔒 locked
  0x1f513, // 🔓 unlocked
  0xfe0f, // variation selector-16
]);

/**
 * Words that claim this surface's own verdict, or the platform's identity.
 *
 * ⚠ COMPARED LOWERCASED AND WITH SURROUNDING PUNCTUATION STRIPPED, so `(Verified)` and
 * `[BALO]` are caught. Homoglyphs are NOT caught — see the module docblock.
 */
const TRUST_WORDS = new Set(['verified', 'unverified', 'official', 'balo', 'baloexpert']);

const PUNCTUATION = new Set(['(', ')', '[', ']', '{', '}', '·', '-', '–', '—', ':', ',', '.', '|']);

/**
 * Drop the trust glyphs.
 *
 * ⚠ A CODE-POINT WALK, NOT A REGEX — the input is attacker-controlled and arrives on a PUBLIC
 * route (S5852). `for…of` over a string iterates CODE POINTS, so a surrogate pair is one
 * iteration and can never be half-removed, which a `charAt` loop or a naive character class
 * both get wrong.
 */
function stripTrustGlyphs(value: string): string {
  let out = '';
  for (const character of value) {
    if (!TRUST_CODEPOINTS.has(character.codePointAt(0) ?? -1)) out += character;
  }
  return out;
}

/** Strip the punctuation a trust word is usually wrapped in, so the comparison can be exact. */
function bareWord(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && PUNCTUATION.has(word.charAt(start))) start += 1;
  while (end > start && PUNCTUATION.has(word.charAt(end - 1))) end -= 1;
  return word.slice(start, end).toLowerCase();
}

/**
 * Reduce an ANONYMOUS visitor's self-declared name to something a host can be shown without
 * the string itself doing the persuading.
 *
 * ⚠⚠ IT COLLAPSES RATHER THAN REJECTS ON AN ADDRESS, DELIBERATELY. A `400` here would tell an
 * anonymous caller which strings the server dislikes and would strand a person whose real
 * problem is a typo; `Guest` lets them through the door and into the queue, where the host
 * decides with the UNVERIFIED badge and the disclosure in front of them — which is the same
 * answer the projector already gives a `link` row with no name at all.
 *
 * ⚠ IT IS NOT A SANITISER FOR OUTPUT ENCODING. React escapes what it renders and the email
 * templates do the same; this is about the CONTENT of a claim, not about markup.
 */
export function sanitizeSelfDeclaredName(raw: string): string {
  if (containsEmailAddress(raw)) return ANONYMOUS_GUEST_NAME;

  const words = stripTrustGlyphs(raw)
    .split(/\s+/)
    .filter((word) => {
      const bare = bareWord(word);
      // ⚠ DROP THE ORPHANED SEPARATOR TOO. `"Dana Okoro - unverified"` leaves a dangling `-`
      // once the claim goes, and a trailing dash reads as a name that got cut off. A token that
      // is ENTIRELY punctuation carries no name either way, so removing it is free.
      return bare.length > 0 && !TRUST_WORDS.has(bare);
    });

  const cleaned = words.join(' ').trim();
  return cleaned.length === 0 ? ANONYMOUS_GUEST_NAME : cleaned;
}
