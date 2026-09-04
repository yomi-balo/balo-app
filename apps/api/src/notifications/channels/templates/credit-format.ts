/**
 * BAL-380 (ADR-1040 Lane 3) — pure display formatters shared by the credit
 * dormancy/expiry email templates and their in-app factories. Defined ONCE here (not
 * inlined in each template file) to keep the balance/date formatting identical across
 * email + in-app and avoid Sonar new-code duplication. No money library — the codebase
 * inlines these (cf. `formatPriceCents` in `in-app-templates.ts`). Presentation only —
 * these NEVER touch balance/settlement math (invariant #8).
 */

/**
 * AUD minor units → the client-facing display string, e.g. `formatAudMinor(34700)` →
 * `'A$347.00'`. Always two fraction digits, thousands-grouped (en-GB). A non-finite
 * input degrades to `'A$0.00'` rather than rendering `NaN`.
 */
export function formatAudMinor(minor: number): string {
  const safe = Number.isFinite(minor) ? minor : 0;
  const amount = (safe / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `A$${amount}`;
}

/**
 * BAL-377 — presentment (card) minor units + a lowercase ISO-4217 code → a display string
 * for the receipt, e.g. `formatPresentmentMinor(4200, 'usd')` → `'USD 42.00'`. Two fraction
 * digits, thousands-grouped (en-GB), the code upper-cased. Presentation only — this is the
 * amount the client's CARD was billed (captured from Stripe), never a balance figure. A
 * non-finite amount degrades to `'0.00'` with the code.
 */
export function formatPresentmentMinor(minor: number, currency: string): string {
  const safe = Number.isFinite(minor) ? minor : 0;
  const amount = (safe / 100).toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const code = currency.length > 0 ? currency.toUpperCase() : '';
  return code ? `${code} ${amount}` : amount;
}

/**
 * ISO instant → long UTC date for email copy, e.g. `'2027-07-12T…'` → `'12 July 2027'`
 * (en-GB, UTC). An unparseable input degrades to `'the expiry date'`.
 */
export function formatExpiryDateLong(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'the expiry date';
  }
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * ISO instant → short UTC date for the denser in-app copy, e.g. `'12 Jul 2027'`
 * (en-GB, UTC). An unparseable input degrades to `'the expiry date'`.
 */
export function formatExpiryDateShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'the expiry date';
  }
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * BAL-521 — the client-facing label for a low-balance mode. Defined ONCE here so the
 * `credit-saved-card-detached` email and in-app copy can never disagree, and so the strings match
 * the web picker VERBATIM — `apps/web/src/components/billing/top-up/LowBalanceModePicker.tsx`'s
 * `MODE_OPTIONS` titles. Presentation only — never touches balance/settlement math.
 *
 * ⚠ BAL-521 (F3) — this claim of "can never disagree" was true only of the MODE LABEL itself; the
 * sentences AROUND it (lead sentence, consequence, headline) were independently re-derived by
 * each channel until `buildSavedCardDetachedCopy` below extracted them to one site. Both channels
 * now call that function, so the whole sentence — not just this label — is shared.
 */
export function lowBalanceModeLabel(mode: string): string {
  if (mode === 'auto_topup') return 'Auto top-up';
  if (mode === 'keep_going') return 'Keep me going';
  return 'Just notify me';
}

/**
 * BAL-521 (F6) — a cheap, prose-appropriate brand label for the saved-card-detached copy.
 * `apps/web/src/components/billing/top-up/CardBrandMark.tsx`'s `formatCardBrand` already solves
 * this correctly, but it lives in a `'use client'` file `apps/api` cannot import — moving it into
 * `@balo/shared` is out of scope for this PR (F6). This map covers the same KNOWN-brand cases
 * (title-cased for a sentence, not the chip's abbreviated form) so a hand-rolled
 * `charAt(0).toUpperCase() + slice(1)` never renders "Jcb" or, worse, the live AU brand
 * "Eftpos_au" verbatim in a client-facing email/in-app sentence.
 */
const CARD_BRAND_LABEL: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'Amex',
  discover: 'Discover',
  diners: 'Diners',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  eftpos_au: 'Eftpos',
};

/** Title-case a raw Stripe card brand for prose, e.g. `cardBrandLabel('eftpos_au')` → `'Eftpos'`. */
export function cardBrandLabel(brand: string): string {
  const known = CARD_BRAND_LABEL[brand.toLowerCase()];
  if (known !== undefined) return known;
  const [first, ...rest] = brand;
  if (first === undefined) return 'Card';
  return first.toUpperCase() + rest.join('');
}

/**
 * BAL-521 §3 (F3) — the copy derivation SHARED by the `credit-saved-card-detached` email and
 * in-app factories. Extracted from what had been two independently-maintained copies (one per
 * channel) that jscpd flagged as a 141-token clone: each re-derived `source`, `cardKnown`,
 * `brandLabel`, the two-arm `leadSentence`, and `consequence` separately, so editing one channel
 * and its test could leave the other silently on the old copy. Both factories now call this ONCE
 * and lay the pieces into their own component/subject shape — neither branches this logic itself.
 */
export interface SavedCardDetachedCopy {
  source: 'user_initiated' | 'stripe_webhook';
  /** Identical string used as the email `headline` and the in-app `title`. */
  headline: string;
  leadSentence: string;
  /** '' is tolerated by both consumers; the shipped derivation below never returns it — every
   *  branch (reconciled or not) has a sentence. */
  consequence: string;
  /** The acting member's bare name, e.g. `'Dana'`, or the `'A teammate'` fallback. Only ever
   *  READ on the `user_initiated` arm — the resolver never sets it on the `stripe_webhook` door,
   *  so it still resolves to the same fallback there but nothing consumes it. */
  bareName: string;
  /** The acting member labelled with their company, e.g. `'Dana @ Northwind Industrial'` — used
   *  for FIRST MENTION in both the subject and the body (CLAUDE.md's attribution rule, F4). Same
   *  unused-on-webhook caveat as `bareName`. */
  label: string;
}

export function buildSavedCardDetachedCopy(data: Record<string, unknown>): SavedCardDetachedCopy {
  const source = data.source === 'user_initiated' ? 'user_initiated' : 'stripe_webhook';
  const cardBrand = typeof data.cardBrand === 'string' ? data.cardBrand : null;
  const cardLast4 = typeof data.cardLast4 === 'string' ? data.cardLast4 : null;
  const cardKnown = cardBrand !== null && cardLast4 !== null;
  const brandLabel = cardKnown ? cardBrandLabel(cardBrand) : '';
  const bareName = (data.detachedByName as string) ?? 'A teammate';
  const label = (data.detachedByLabel as string) ?? bareName;
  const modeReconciled = data.modeReconciled === true;
  const previousLowBalanceMode = (data.previousLowBalanceMode as string) ?? 'notify_only';

  const headline =
    source === 'user_initiated' ? 'Saved card removed' : 'Your saved card was removed';

  let leadSentence: string;
  if (source === 'stripe_webhook') {
    leadSentence = cardKnown
      ? `Your saved ${brandLabel} ending ${cardLast4} was removed by your bank or card provider.`
      : 'Your saved card was removed by your bank or card provider.';
  } else {
    leadSentence = cardKnown
      ? `${label} removed the saved card — the ${brandLabel} ending ${cardLast4}.`
      : `${label} removed the saved card.`;
  }

  const consequence = modeReconciled
    ? `${lowBalanceModeLabel(previousLowBalanceMode)} is now off — you're on Just notify me. Add a card in Billing settings to turn it back on.`
    : 'You were already on Just notify me, so nothing else changed.';

  return { source, headline, leadSentence, consequence, bareName, label };
}
