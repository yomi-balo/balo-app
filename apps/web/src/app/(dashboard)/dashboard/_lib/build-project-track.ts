import type { DashboardTrackStage, DashboardTrackTurn } from '@balo/analytics/events';
import type { PortfolioRowView, StageKey } from '@/lib/projects-inbox/portfolio-row';
import type {
  ProjectTrackToken,
  ProjectTrackView,
  YourMoveWorkspaceType,
} from './your-move-view-types';

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

/**
 * Same test the rail uses to emit a project card (`needsYou` plus this lens's move kind), so every
 * Your move token has a card by construction.
 */
function turnOf(row: PortfolioRowView, workspaceType: YourMoveWorkspaceType): DashboardTrackTurn {
  const moveKind = workspaceType === 'expert' ? row.moveKind : row.clientMoveKind;
  if (row.needsYou && moveKind !== null && moveKind !== undefined) return 'your_move';
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
      turn: turnOf(row, workspaceType),
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
