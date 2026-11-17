import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

/** "+61406431059" → "+61 406 431 059"; anything unparseable is shown as stored. */
export function formatPhoneForDisplay(e164: string): string {
  return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;
}
