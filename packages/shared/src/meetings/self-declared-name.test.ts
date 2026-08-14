import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_GUEST_NAME,
  containsEmailAddress,
  sanitizeSelfDeclaredName,
} from './self-declared-name';

/**
 * BAL-436 — the address scan and the self-declared-name reduction.
 *
 * ⚠⚠ THE LOAD-BEARING PROPERTY IS THAT AN ANONYMOUS VISITOR CANNOT TYPE AN ADDRESS — OR THIS
 * SURFACE'S OWN "VERIFIED" VOCABULARY — INTO THE ONE COLUMN THE HOST ACTUALLY READS. The
 * projector strips `email`; `name` is the neighbouring column and is passed through verbatim.
 *
 * ⚠ THE SCAN IS BIASED TOWARD FALSE ALARMS ON PURPOSE. Every "does NOT match" case below is
 * therefore a case that would break the HARNESS if it matched (a stack-trace path, a version
 * string), not a case where a near-miss address is being waved through.
 */

describe('containsEmailAddress', () => {
  it.each([
    ['a bare address', 'dana.okoro@northwind.com'],
    ['an address inside prose', 'Contact me at dana@northwind.example please'],
    ['a plus-tagged local part', 'dana+meetings@northwind.co.uk'],
    ['an address as a display name', 'dana.okoro@northwind.com'],
  ])('finds %s', (_label, text) => {
    expect(containsEmailAddress(text)).toBe(true);
  });

  it.each([
    ['a plain name', 'Dana Okoro'],
    ['a bare handle with no domain', '@dana'],
    ['an @ with nothing address-like before it', 'meet @ 3pm at hq.example'],
    // ⚠ THE HARNESS CASE. A pnpm path is the reason the tld must be ALPHABETIC: a rule of
    // "a dot with two characters after it" matches `4.0.18`, and the first version of this
    // scan failed on the test runner rather than on a leak.
    ['a pnpm store path', '/node_modules/.pnpm/@vitest+runner@4.0.18/dist/index.js'],
    ['a version-shaped suffix', 'build@1.2.3'],
    ['an empty string', ''],
  ])('does NOT match %s', (_label, text) => {
    expect(containsEmailAddress(text)).toBe(false);
  });
});

describe('sanitizeSelfDeclaredName — ⚠⚠ the knock a host reads', () => {
  it('leaves an ordinary name byte for byte', () => {
    expect(sanitizeSelfDeclaredName('Dana Okoro')).toBe('Dana Okoro');
  });

  it('⚠⚠ COLLAPSES A NAME THAT IS AN ADDRESS — the concealment is field-scoped', () => {
    expect(sanitizeSelfDeclaredName('dana.okoro@northwind.com')).toBe(ANONYMOUS_GUEST_NAME);
  });

  it('⚠ collapses an address HIDDEN INSIDE an otherwise plausible name', () => {
    expect(sanitizeSelfDeclaredName('Dana Okoro dana@northwind.example')).toBe(
      ANONYMOUS_GUEST_NAME
    );
  });

  it.each([
    ['a check-mark plus the badge word', 'Dana Okoro ✅ Verified', 'Dana Okoro'],
    ['the badge word alone', 'Dana Okoro (Verified)', 'Dana Okoro'],
    ['the inverted claim', 'Dana Okoro - unverified', 'Dana Okoro'],
    ['a platform claim', 'Balo Support', 'Support'],
    ['an official claim', 'Dana Okoro [OFFICIAL]', 'Dana Okoro'],
    ['a shield glyph', '🛡 Dana Okoro', 'Dana Okoro'],
    ['a variation-selected tick', 'Dana Okoro ✔️', 'Dana Okoro'],
  ])('⚠ strips %s', (_label, raw, expected) => {
    expect(sanitizeSelfDeclaredName(raw)).toBe(expected);
  });

  it('⚠ falls back to Guest when NOTHING survives the strip', () => {
    expect(sanitizeSelfDeclaredName('✅ Verified')).toBe(ANONYMOUS_GUEST_NAME);
  });

  it('⚠ collapses whitespace it created rather than leaving a double space', () => {
    expect(sanitizeSelfDeclaredName('Dana  ✅  Okoro')).toBe('Dana Okoro');
  });

  it('⚠ NEVER HALF-REMOVES A SURROGATE PAIR — an emoji it does not know is left intact', () => {
    // 😀 shares its LEAD surrogate with 🛡. A `charAt` walk would delete the lead and leave a
    // lone trail code unit in the database; the code-point walk cannot.
    expect(sanitizeSelfDeclaredName('Dana 😀 Okoro')).toBe('Dana 😀 Okoro');
  });

  /**
   * ⚠⚠ THE STATED LIMIT, PINNED SO IT CANNOT BE MISREAD AS COVERAGE. An organisational claim
   * survives, and it is meant to: the UNVERIFIED badge and the queue disclosure ("Balo hasn't
   * checked who they are") are the answer to it. Nothing here pretends to make a stranger's
   * name true.
   */
  it('⚠ does NOT strip an arbitrary organisational claim — that is the badge`s job', () => {
    expect(sanitizeSelfDeclaredName('Dana Okoro (Northwind IT)')).toBe('Dana Okoro (Northwind IT)');
  });
});
