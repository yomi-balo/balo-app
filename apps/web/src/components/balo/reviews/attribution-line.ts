import type { ReviewAttribution, ReviewBodyVisibility } from '@balo/shared/reviews';

/**
 * The line under the capture form: what goes public and how the reviewer is named. Pure.
 *
 * ⚠ DRAFT COPY — pending MJ sign-off. The name and descriptor come from
 * `formatReviewAttribution`, so this line, the Preview and the public display cannot disagree.
 * A private note is only claimed when there IS a note to be private.
 */
export function buildAttributionLine({
  expertName,
  attribution,
  hasNote,
  bodyVisibility,
}: Readonly<{
  expertName: string;
  attribution: ReviewAttribution;
  hasNote: boolean;
  bodyVisibility: ReviewBodyVisibility;
}>): { text: string; privateNote: boolean } {
  const asShown =
    attribution.descriptor === null
      ? attribution.name
      : `${attribution.name}, ${attribution.descriptor}`;
  const privateNote = hasNote && bodyVisibility === 'private';
  if (privateNote) {
    return {
      text: `Your rating shows on ${expertName}’s profile as ${asShown}. Only the Balo team sees your note.`,
      privateNote,
    };
  }
  const shown = hasNote ? 'rating and note show' : 'rating shows';
  return { text: `Your ${shown} on ${expertName}’s profile as ${asShown}.`, privateNote };
}
