/**
 * BAL-581 — the pre-call copy for a meeting whose call room is not ready yet. Balo owns the
 * failure; nobody is named; gender-neutral. Promises only what is true: WHERE the Join appears,
 * never WHEN.
 */
export const ROOM_SETTING_UP_LABEL = 'Setting up your call room';
export const ROOM_SETTING_UP_SHORT_LABEL = 'Setting up room';
export const ROOM_SETTING_UP_ROW_LABEL = 'Setting up call room';
export function roomSettingUpNudgeBody(lens: 'client' | 'expert', counterparty: string): string {
  return lens === 'client'
    ? `Your call room with ${counterparty} isn't ready yet — that's on us, and our team has been alerted. You'll be able to join from here once it's ready.`
    : `The call room for your consultation with ${counterparty} isn't ready yet — that's on us, and our team has been alerted. You'll be able to join from here once it's ready.`;
}
