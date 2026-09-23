import type { SettingsStatusTone } from '../_components/settings-card';
import type { CalendarSlotState } from './calendar-slot-state';

export interface CalendarSlotStatus {
  readonly words: string;
  readonly tone: SettingsStatusTone;
}

/**
 * The status pill for each slot state — the words a calendar row shows beside its provider,
 * and the words the "Add calendar" menu shows beside a provider it cannot offer. One map so
 * the two surfaces cannot disagree about what a slot is called.
 *
 * `null` means "no pill": `idle` is a provider with no slot at all (it renders as an
 * invitation row instead), and `o365_guidance` is a modal, not a row — see `occupiesSlot` in
 * `calendar-connections-section.tsx`. Both stay in the map because it is total over
 * `CalendarSlotState`.
 */
export const CALENDAR_SLOT_STATUS: Record<CalendarSlotState, CalendarSlotStatus | null> = {
  idle: null,
  connected: { words: 'Connected', tone: 'success' },
  setting_up: { words: 'Setting up', tone: 'neutral' },
  reconnect_needed: { words: 'Reconnect needed', tone: 'warning' },
  attempt_failed: { words: "Didn't finish", tone: 'destructive' },
  connecting: { words: 'Waiting for you', tone: 'neutral' },
  o365_guidance: null,
  o365_waiting: { words: 'Waiting on IT', tone: 'warning' },
};
