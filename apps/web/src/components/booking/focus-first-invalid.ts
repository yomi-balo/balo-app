import { isDescriptionEmpty } from '@/components/balo/rich-text/plain-text';

/** The DOM ids of the Review & confirm fields a validation stop can point at. */
export const BOOKING_FIELD_IDS = {
  title: 'booking-title',
  description: 'booking-description',
  company: 'booking-company-picker',
} as const;

export interface FieldValidationState {
  /** `true` for a new case, whose title and description are required. */
  readonly isNewCase: boolean;
  readonly title: string;
  readonly descriptionHtml: string;
  /** `true` when a company must be chosen and none is. */
  readonly companyMissing: boolean;
}

/**
 * The element a validation stop should land on: the first invalid field in reading order (title,
 * description, company), or `null` when every field is valid or not on screen.
 */
export function findFirstInvalidField(state: FieldValidationState): HTMLElement | null {
  const { document } = globalThis;
  if (state.isNewCase && state.title.trim().length === 0) {
    return document.getElementById(BOOKING_FIELD_IDS.title);
  }
  if (state.isNewCase && isDescriptionEmpty(state.descriptionHtml)) {
    const editor = document.getElementById(BOOKING_FIELD_IDS.description);
    return editor?.querySelector<HTMLElement>('[contenteditable="true"], textarea') ?? editor;
  }
  if (state.companyMissing) return document.getElementById(BOOKING_FIELD_IDS.company);
  return null;
}
