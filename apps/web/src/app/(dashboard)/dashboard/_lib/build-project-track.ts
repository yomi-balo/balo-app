import type { DashboardTrackStage, DashboardTrackTurn } from '@balo/analytics/events';
import type { PortfolioRowView } from '@/lib/projects-inbox/portfolio-row';
import {
  PARTICIPANT_STAGES,
  participantStageFor,
  stageLensOfWorkspace,
} from '@/lib/projects-inbox/project-stages';
import type {
  ProjectTrackToken,
  ProjectTrackView,
  YourMoveWorkspaceType,
} from './your-move-view-types';

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
  const lens = stageLensOfWorkspace(workspaceType);
  const tokensByStage = new Map<DashboardTrackStage, ProjectTrackToken[]>();
  let total = 0;

  for (const row of rows) {
    const stage = participantStageFor(lens, row.stage)?.key;
    if (stage === undefined || isFinished(row)) continue;
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
    stages: PARTICIPANT_STAGES[lens].map(({ key, label, explanation }) => {
      const tokens = tokensByStage.get(key) ?? [];
      return {
        key,
        label,
        explanation,
        tokens,
        hasYourMove: tokens.some((t) => t.turn === 'your_move'),
      };
    }),
  };
}
