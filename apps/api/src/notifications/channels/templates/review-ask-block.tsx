import { Column, Link, Row, Section, Text } from '@react-email/components';
import type { CSSProperties } from 'react';
import { reviewColors } from './review-email-shared.js';

/**
 * BAL-390 — the in-email star-rating ask. ONE component, four carriers:
 *   · `engagement-accepted-client`      (client explicitly accepted a project)
 *   · `engagement-auto-accepted-client` (VARIANT 3, the D7 sweep closed it out)
 *   · `engagement-case-closed-client`   (the fused case-close email — INERT today)
 *   · `review-nudge`                    (the +24h / +7d sweep, both cadence steps)
 *
 * Defining it exactly once is what keeps four consumers under SonarCloud's >3%
 * new-code duplication gate — do not inline a second copy of this row anywhere.
 *
 * ── THE FIVE CONSTRAINTS THAT *ARE* THE DESIGN (BAL-390-DESIGN Artifact 2) ───────
 *
 * 1. NO `:hover`. Gmail and Outlook desktop strip it, so a fill-on-hover would be
 *    invisible for most recipients and inconsistent for the rest. Five STATIC,
 *    identically drawn targets. Do not add a hover fill.
 * 2. NO INLINE SVG. Outlook desktop renders through Word and drops it. The star is
 *    the Unicode ★ (U+2605) as TEXT, coloured `#CBD5E1` so it reads as empty.
 *    Rejected, and why: hosted PNG (blocked by default), CSS shapes (stripped),
 *    emoji ⭐ (fixed colour — cannot read as empty), ☆ U+2606 (far thinner font
 *    coverage than ★, renders as tofu where ★ does not).
 * 3. PERCENTAGE-WIDTH TARGETS, NEVER FIXED. Five fixed 56px boxes plus gutters
 *    cannot fit a 560px container's padding on a 320px phone — the row wraps or
 *    clips, the worst available failure. So: one full-width row of five 20% cells
 *    with an `<a display:block>` filling each. It is five across and never wraps at
 *    ANY width. The row also bleeds out of its host card's horizontal padding (see
 *    `hostPaddingPx`) so each target stays ≥44px wide at a 320px viewport.
 * 4. ⚠⚠ THE LINK PREFILLS — IT NEVER WRITES. Every star is a plain
 *    `GET /review/{token}?r={n}` that LANDS on the review form with that score
 *    filled in. Gmail's link proxy, Microsoft Defender Safe Links detonation,
 *    Proofpoint/Barracuda rewriting and MDM prefetch all issue unsolicited GETs; a
 *    writing GET would submit ratings nobody chose, silently, at marketplace scale,
 *    and corrupt the aggregate irreversibly. The write is a Next Server Action
 *    (POST-only by construction). This is a SECURITY PROPERTY, not a preference.
 * 5. ALWAYS A NO-STAR PATH. The same URL with no `?r` — covers glyph failure, image
 *    blocking, screen readers, and anyone who would rather read the page before
 *    scoring. ⚠ It lands on the EMPTY-rating state, whose note box is gated behind a
 *    chosen star, so this link must never be sold as "write a few words first".
 *
 * There is ZERO `:hover`, `@media` or `className` anywhere in the notifications
 * tree, and no template hand-writes `<table>` (`Row`/`Column` emit them). Keep it
 * that way — `review-emails.test.ts` asserts all four.
 *
 * All copy here is DRAFT pending MJ sign-off. Gender-neutral throughout.
 */

/** ★ U+2605 — a FILLED glyph in a light colour, never ☆ U+2606 (see constraint 2). */
const STAR_GLYPH = '★';

/** The five discrete scores. Whole stars only — no halves, no fractional fill. */
const STAR_VALUES = [1, 2, 3, 4, 5] as const;

/**
 * Horizontal padding of the card this block is dropped into, in px. The star row
 * cancels it so the five targets get the FULL card width.
 *
 * ⚠⚠ THE NEGATIVE MARGIN ALONE DOES NOTHING — IT ONLY SHIFTS THE ROW. `Section` emits
 * `<table align="center" width="100%">`, and that `width="100%"` resolves against the
 * card's INNER box whatever the margins say; a lone `margin: 0 -40px` over-constrains
 * the margin equation, the browser discards `margin-right`, and the row is merely
 * TRANSLATED 40px left at the same width. The bleed therefore needs BOTH halves:
 *   · `width: calc(100% + 2 × hostPaddingPx)` — what actually buys the 80px back, and
 *   · `boxSizing: border-box`               — so the row's own `0 12px` gutter is taken
 *                                             OUT of that width instead of added to it.
 * Measured on the rendered HTML in headless Chromium (star `<a>` computed width, and
 * the row's centre against the prompt's):
 *   margin only  → 30.9px @320 · 39.4px @375 · 47.2px @414, row 34–40px off-centre
 *   both halves  → 44.4px @320 · 55.4px @375 · 63.2px @414, centred, no overflow
 * Only the second clears the ≥44px tap-target floor. `review-emails.test.ts` pins both
 * declarations so the pair cannot be half-reverted back to the no-op.
 *
 * Clients that drop `calc()` and negative table margins (Outlook desktop — which is
 * never 320px wide) simply render the row at the card's inner width: still five across,
 * still no wrap, just narrower. Defaults to the review-email family card's 40px
 * (`reviewStyles.card`).
 */
const DEFAULT_HOST_PADDING_PX = 40;

/** The star row's own inner gutter, in px — inside the bled width, not added to it. */
const STAR_ROW_GUTTER_PX = 12;

export interface ReviewAskBlockProps {
  /** App origin — `${baseUrl}/review/{token}` is the landing route. */
  readonly baseUrl: string;
  /** The RAW review-invite token. Appears ONLY inside these hrefs — never as copyable text. */
  readonly reviewToken: string;
  /** The carrier's own ask, e.g. "How was your consultation with CloudPeak Consulting?" */
  readonly promptLine: string;
  /** Horizontal padding of the host card, cancelled by the star row. See above. */
  readonly hostPaddingPx?: number;
}

const promptStyle: CSSProperties = {
  fontSize: '15px',
  fontWeight: '650',
  color: reviewColors.text,
  textAlign: 'center',
  margin: '0 0 4px',
  lineHeight: '1.5',
};

const starCellStyle: CSSProperties = {
  width: '20%',
  padding: '0 4px',
  textAlign: 'center',
  verticalAlign: 'top',
};

const starLinkStyle: CSSProperties = {
  display: 'block',
  height: '58px',
  lineHeight: '58px',
  // Light enough to read as an EMPTY star while still being a filled glyph.
  color: '#CBD5E1',
  fontSize: '30px',
  textDecoration: 'none',
};

const numeralStyle: CSSProperties = {
  fontSize: '11px',
  fontWeight: '600',
  color: reviewColors.textTertiary,
  textAlign: 'center',
  margin: '0',
  lineHeight: '1.2',
};

const disclosureStyle: CSSProperties = {
  fontSize: '12px',
  color: reviewColors.textTertiary,
  textAlign: 'center',
  margin: '14px 0 0',
  lineHeight: '1.55',
};

const escapeWrapperStyle: CSSProperties = {
  fontSize: '13px',
  textAlign: 'center',
  margin: '12px 0 0',
  lineHeight: '1.5',
};

const escapeLinkStyle: CSSProperties = {
  color: reviewColors.textSecondary,
  fontWeight: '600',
  textDecoration: 'underline',
};

/** The star row + its prefill disclosure + the always-present no-star escape. */
export function ReviewAskBlock({
  baseUrl,
  reviewToken,
  promptLine,
  hostPaddingPx = DEFAULT_HOST_PADDING_PX,
}: Readonly<ReviewAskBlockProps>) {
  const reviewUrl = `${baseUrl}/review/${reviewToken}`;
  return (
    <Section style={{ margin: '26px 0 4px' }}>
      <Text style={promptStyle}>{promptLine}</Text>

      {/* Full-bleed star row — see constraint 3 and `hostPaddingPx`. The negative margin
          and the `calc()` width are ONE mechanism: the margin without the width only
          translates the row, it never widens it. Do not drop either. */}
      <Section
        style={{
          margin: `10px -${hostPaddingPx}px 0`,
          padding: `0 ${STAR_ROW_GUTTER_PX}px`,
          width: `calc(100% + ${hostPaddingPx * 2}px)`,
          boxSizing: 'border-box',
        }}
      >
        <Row style={{ width: '100%' }}>
          {STAR_VALUES.map((value) => (
            <Column key={value} style={starCellStyle}>
              <Link
                href={`${reviewUrl}?r=${value}`}
                style={starLinkStyle}
                aria-label={`Rate ${value} out of 5`}
              >
                {STAR_GLYPH}
              </Link>
              <p style={numeralStyle}>{value}</p>
            </Column>
          ))}
        </Row>
      </Section>

      {/* The user-facing statement of the never-writes property. It must stay TRUE. */}
      <Text style={disclosureStyle}>
        Tapping a star opens your review with that score already filled in — you can change it
        there, and nothing is saved until you send it.
      </Text>

      {/* The no-star path (constraint 5). ⚠ It must NOT promise a writable field: the
          landing gates its note box behind a chosen star ("Pick a star to send your
          review", BAL-390-DESIGN Artifact 3), so "write a few words first" would be
          false of every arrival. What this link actually does is open the review with
          nothing filled in — say only that. */}
      <Text style={escapeWrapperStyle}>
        <Link href={reviewUrl} style={escapeLinkStyle}>
          Rather open your review first? →
        </Link>
      </Text>
    </Section>
  );
}
