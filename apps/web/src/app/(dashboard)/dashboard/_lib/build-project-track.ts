import type { DashboardTrackStage, DashboardTrackTurn } from '@balo/analytics/events';
import type { PortfolioRowView, StageKey } from '@/lib/projects-inbox/portfolio-row';
import type { YourMoveWorkspaceType } from './your-move-view-types';

export interface ProjectTrackToken {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly href: string;
  readonly turn: DashboardTrackTurn;
}

export interface ProjectTrackStage {
  readonly key: DashboardTrackStage;
  readonly label: string;
  readonly tokens: readonly ProjectTrackToken[];
  readonly hasYourMove: boolean;
}

export interface ProjectTrackView {
  readonly workspaceType: YourMoveWorkspaceType;
  readonly stages: readonly ProjectTrackStage[];
}

interface TrackCopy {
  readonly title: string;
  readonly sub: string;
  readonly waiting: string;
}

export const PROJECT_TRACK_COPY: Record<YourMoveWorkspaceType, TrackCopy> = {
  expert: {
    title: 'Where your projects stand',
    sub: 'Every live project, and whose move it is.',
    waiting: 'Waiting on client',
  },
  company: {
    title: 'Where your projects stand',
    sub: 'Every open request and project, and whose move it is.',
    waiting: 'Waiting on others',
  },
};

export const PROJECT_TRACK_YOUR_MOVE = 'Your move';
export const PROJECT_TRACK_IN_PROGRESS = 'In progress';
export const PROJECT_TRACK_NONE = 'None';

interface StageDef {
  readonly key: DashboardTrackStage;
  readonly label: string;
}

const STAGE_DEFS: Record<YourMoveWorkspaceType, readonly StageDef[]> = {
  expert: [
    { key: 'invited', label: 'Invited' },
    { key: 'eoi', label: 'Interest sent' },
    { key: 'proposal', label: 'Proposal' },
    { key: 'kickoff', label: 'Kickoff' },
    { key: 'delivery', label: 'Delivery' },
  ],
  company: [
    { key: 'matching', label: 'Matching' },
    { key: 'interest', label: 'Interest' },
    { key: 'proposal', label: 'Proposals' },
    { key: 'kickoff', label: 'Kickoff' },
    { key: 'delivery', label: 'Delivery' },
  ],
};

/**
 * A `null` stage is dropped from the track. `requested`/`exploratory` are mapped on the expert
 * lens so nothing drops silently.
 */
const STAGE_OF: Record<YourMoveWorkspaceType, Record<StageKey, DashboardTrackStage | null>> = {
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
  company: {
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

function turnOf(row: PortfolioRowView): DashboardTrackTurn {
  if (row.needsYou) return 'your_move';
  if (row.kind === 'engagement' && row.deliveryState === 'in_delivery') return 'in_progress';
  return 'waiting';
}

function isFinished(row: PortfolioRowView): boolean {
  return row.deliveryState === 'completed' || row.deliveryState === 'cancelled';
}

/**
 * Groups the live portfolio rows into the dashboard track. Tokens carry only an id, a label, the
 * project title, a link and whose move it is: no money, no signal, no person on the expert lens.
 * Returns `null` when no live row remains, because the track has nothing to open then.
 */
export function buildProjectTrack(
  rows: readonly PortfolioRowView[],
  workspaceType: YourMoveWorkspaceType
): ProjectTrackView | null {
  const stageOf = STAGE_OF[workspaceType];
  const tokensByStage = new Map<DashboardTrackStage, ProjectTrackToken[]>();
  let total = 0;

  for (const row of rows) {
    const stage = stageOf[row.stage];
    if (stage === null || isFinished(row)) continue;
    const token: ProjectTrackToken = {
      id: row.id,
      label: workspaceType === 'expert' ? (row.companyName ?? row.title) : row.title,
      title: row.title,
      href: row.href ?? '/projects',
      turn: turnOf(row),
    };
    const bucket = tokensByStage.get(stage);
    if (bucket) bucket.push(token);
    else tokensByStage.set(stage, [token]);
    total += 1;
  }

  if (total === 0) return null;

  return {
    workspaceType,
    stages: STAGE_DEFS[workspaceType].map(({ key, label }) => {
      const tokens = tokensByStage.get(key) ?? [];
      return { key, label, tokens, hasYourMove: tokens.some((t) => t.turn === 'your_move') };
    }),
  };
}
