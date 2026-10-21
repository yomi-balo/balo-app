import type { DashboardTrackStage, DashboardTrackTurn } from '@balo/analytics/events';
import type { Workspace } from '@balo/shared/workspaces';
import type { StageKey } from './portfolio-row';

/**
 * project-stages — the participant stage vocabulary shared by the dashboard track and the
 * Projects inbox chips: five stages per lens (key, label, one sentence), the `StageKey` → stage
 * mapping, and the legend sentences. Type-only imports, so it is client-safe like
 * `portfolio-row.ts`. Admin surfaces keep the staff vocabulary (`STAGE_LABELS`, `KANBAN_STAGES`).
 */

export type ParticipantStageLens = 'client' | 'expert';

export interface ParticipantStage {
  readonly key: DashboardTrackStage;
  readonly label: string;
  readonly explanation: string;
}

export const PARTICIPANT_STAGES: Record<ParticipantStageLens, readonly ParticipantStage[]> = {
  expert: [
    {
      key: 'invited',
      label: 'Invited',
      explanation:
        'Balo invited you to this project. Read the brief and send your interest if it’s a fit.',
    },
    {
      key: 'eoi',
      label: 'Interest sent',
      explanation:
        'You’ve told the client you’re interested, or they asked you directly. Next, you talk and they may ask for a proposal.',
    },
    {
      key: 'proposal',
      label: 'Proposal',
      explanation: 'The client asked you for a proposal, or is reviewing the one you sent.',
    },
    {
      key: 'kickoff',
      label: 'Kickoff',
      explanation:
        'Your proposal was accepted. The project starts once you, the client and Balo have each confirmed.',
    },
    {
      key: 'delivery',
      label: 'Delivery',
      explanation:
        'The project is underway. You deliver the milestones and the client reviews the work.',
    },
  ],
  client: [
    {
      key: 'matching',
      label: 'Matching',
      explanation:
        'Balo is finding experts for your request, or wants a quick call with you first.',
    },
    {
      key: 'interest',
      label: 'Interest',
      explanation:
        'Experts are interested, or the expert you asked directly is looking at your request. Talk with them and ask the ones you like for a proposal.',
    },
    {
      key: 'proposal',
      label: 'Proposals',
      explanation: 'Experts are writing proposals, or have sent them for you to review.',
    },
    {
      key: 'kickoff',
      label: 'Kickoff',
      explanation:
        'You’ve accepted a proposal. The project starts once you, the expert and Balo have each confirmed.',
    },
    {
      key: 'delivery',
      label: 'Delivery',
      explanation:
        'The project is underway. You review the work when the expert marks it complete.',
    },
  ],
};

export const TURN_EXPLANATIONS: Record<ParticipantStageLens, Record<DashboardTrackTurn, string>> = {
  expert: {
    your_move: 'Something here is waiting on you.',
    waiting: 'You’ve done your part. The client, or Balo, is up next.',
    in_progress: 'Work is underway and nobody is blocked.',
  },
  client: {
    your_move: 'Something here is waiting on you.',
    waiting: 'You’ve done your part. The expert, or Balo, is up next.',
    in_progress: 'Work is underway and nobody is blocked.',
  },
};

export const CLOSED_STAGE_LABEL = 'Closed';

/**
 * A `null` stage is dropped from the track. `requested`/`exploratory` are mapped on the expert
 * lens so nothing drops silently.
 */
const STAGE_OF: Record<ParticipantStageLens, Record<StageKey, DashboardTrackStage | null>> = {
  expert: {
    requested: 'invited',
    exploratory: 'invited',
    invited: 'invited',
    eoi: 'eoi',
    prop_req: 'proposal',
    prop_in: 'proposal',
    accepted: 'kickoff',
    kicked: 'delivery',
    closed: null,
  },
  client: {
    requested: 'matching',
    exploratory: 'matching',
    invited: 'matching',
    eoi: 'interest',
    prop_req: 'proposal',
    prop_in: 'proposal',
    accepted: 'kickoff',
    kicked: 'delivery',
    closed: null,
  },
};

const STAGE_BY_KEY: Record<
  ParticipantStageLens,
  ReadonlyMap<DashboardTrackStage, ParticipantStage>
> = {
  expert: new Map(PARTICIPANT_STAGES.expert.map((stage) => [stage.key, stage])),
  client: new Map(PARTICIPANT_STAGES.client.map((stage) => [stage.key, stage])),
};

export function stageLensOfWorkspace(type: Workspace['type']): ParticipantStageLens {
  return type === 'company' ? 'client' : 'expert';
}

/** The participant stage a `StageKey` belongs to on this lens; `null` for a closed request. */
export function participantStageFor(
  lens: ParticipantStageLens,
  stage: StageKey
): ParticipantStage | null {
  const key = STAGE_OF[lens][stage];
  if (key === null) return null;
  return STAGE_BY_KEY[lens].get(key) ?? null;
}

export function participantStageLabel(lens: ParticipantStageLens, stage: StageKey): string {
  return participantStageFor(lens, stage)?.label ?? CLOSED_STAGE_LABEL;
}
