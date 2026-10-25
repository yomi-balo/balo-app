import type { AdminAlertDetail } from '@balo/shared/admin-alerts';
import { joinTitles } from '@balo/shared/engagements';

interface RepeatChangeRequestAlertInput {
  projectTitle: string;
  clientCompanyName: string;
  /** Retrospective client person, "Dana @ Northwind Industrial". */
  actorClientLabel: string;
  /** The delivering expert's party label. */
  expertLabel: string;
  roundNumber: number;
  taggedMilestoneTitles: readonly string[];
  /** Pre-formatted request date, e.g. "6 Jul". */
  requestedOn: string;
}

/**
 * The `admin_alerts.detail` for a client sending a project back for another round
 * (`project.repeat_change_request`). Carries no note and no money: the facts are read
 * verbatim by every staff viewer, and the note is the client's free text.
 */
export function buildRepeatChangeRequestAlertDetail(
  input: RepeatChangeRequestAlertInput
): AdminAlertDetail {
  const tagged = joinTitles(input.taggedMilestoneTitles);
  return {
    title: `Changes requested again on ${input.projectTitle}`,
    entityLabel: `${input.projectTitle} · ${input.clientCompanyName}`,
    evidence: `${input.actorClientLabel} sent it back to ${input.expertLabel} for round ${input.roundNumber} on ${input.requestedOn}.`,
    facts: [
      ['Round', String(input.roundNumber)],
      ['Client', input.clientCompanyName],
      ['Expert', input.expertLabel],
      ['Tagged milestones', tagged === '' ? 'None' : tagged],
    ],
  };
}
