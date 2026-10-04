import { z } from 'zod';
import {
  htmlToPlainText,
  isRichTextHtml,
  plainTextLength,
  toRichTextHtml,
} from '@/components/balo/rich-text/plain-text';

/**
 * A work-history entry's "Responsibilities" — rich text since the field moved from a plain
 * textarea to the shared editor. CLIENT-SAFE (zod + pure helpers only), so the form and both
 * server actions read ONE rule.
 *
 * ⚠ VALUES ARE MIXED-FORMAT. Rows and anonymous localStorage drafts written before the switch
 * hold plain text; every reader goes through `toRichTextHtml` (or `responsibilitiesPreview`),
 * which passes editor HTML through and turns legacy plain text into escaped paragraphs.
 */

/** The visible-text limit — unchanged from the textarea's 1,000 characters. */
export const RESPONSIBILITIES_MAX_TEXT = 1000;

/**
 * A bound on the RAW HTML, separate from the visible-text limit: markup inflates the string, but
 * an unbounded one is a payload-size hazard for a field the server parses and sanitises.
 */
export const RESPONSIBILITIES_MAX_HTML = 10_000;

export const RESPONSIBILITIES_TOO_LONG = `Keep responsibilities under ${RESPONSIBILITIES_MAX_TEXT} characters.`;

/** Visible characters in a value of either format. */
export function responsibilitiesTextLength(value: string | null | undefined): number {
  return plainTextLength(toRichTextHtml(value));
}

/** The server-side field rule (both write paths). Empty is allowed — the field is optional. */
export const responsibilitiesFieldSchema = z
  .string()
  .max(RESPONSIBILITIES_MAX_HTML, RESPONSIBILITIES_TOO_LONG)
  .refine(
    (value) => responsibilitiesTextLength(value) <= RESPONSIBILITIES_MAX_TEXT,
    RESPONSIBILITIES_TOO_LONG
  );

/** One line of visible text for a compact card preview, from a value of either format. */
export function responsibilitiesPreview(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return isRichTextHtml(value) ? htmlToPlainText(value) : value.trim();
}
