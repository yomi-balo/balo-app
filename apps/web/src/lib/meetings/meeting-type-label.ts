import type { MeetingContextTypeWithHolder } from '@balo/shared/meetings';

/**
 * BAL-566 (D5) — THE EYEBROW / TYPE LABEL, extracted VERBATIM from `resolve-eyebrow.ts`'s
 * `EYEBROW_BY_CONTEXT`, so `resolve-eyebrow.ts` and the dashboard Up next card (which needs the
 * same six labels, four of them rendered) share one definition.
 *
 * This is CONTEXT-type grain (six labels: `case`, `project_discovery`, `project_kickoff`,
 * `package_session`, `retainer_checkin`, `request_interaction`) — a DIFFERENT axis from
 * `lib/calendar/engagement-type-indicator.ts`, which is ENGAGEMENT-type grain (case vs project).
 *
 * The record is TOTAL over `MeetingContextTypeWithHolder` — no `default:` arm that could render
 * an enum value at a user — so a seventh label added to `meeting_context_type` fails `tsc` here
 * rather than shipping a raw enum value to a client.
 *
 * ⚠ STORED IN SENTENCE CASE; ANY `uppercase` PRESENTATION IS CSS. Assistive tech spells short
 * all-caps strings out letter by letter.
 *
 * ⚠ MJ COPY CHECKPOINT — "Intro call" (`request_interaction`) wording may change without
 * reopening the RENDERING ruling that ships it.
 */
export const MEETING_TYPE_LABEL: Record<MeetingContextTypeWithHolder, string> = {
  case: 'Consultation',
  project_discovery: 'Discovery call',
  project_kickoff: 'Project kickoff',
  package_session: 'Package session',
  retainer_checkin: 'Retainer check-in',
  request_interaction: 'Intro call',
};

/** The type label for a primary context type. */
export function meetingTypeLabel(contextType: MeetingContextTypeWithHolder): string {
  return MEETING_TYPE_LABEL[contextType];
}
