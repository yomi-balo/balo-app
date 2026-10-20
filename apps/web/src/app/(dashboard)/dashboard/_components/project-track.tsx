'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import type { DashboardTrackTurn } from '@balo/analytics/events';
import { cn } from '@/lib/utils';
import { track, DASHBOARD_EVENTS } from '@/lib/analytics';
import {
  PROJECT_TRACK_COPY,
  PROJECT_TRACK_IN_PROGRESS,
  PROJECT_TRACK_NONE,
  PROJECT_TRACK_YOUR_MOVE,
  type ProjectTrackStage,
  type ProjectTrackToken,
  type ProjectTrackView,
} from '../_lib/build-project-track';
import type { YourMoveWorkspaceType } from '../_lib/your-move-view-types';

interface TurnStyle {
  readonly token: string;
  readonly dot: string;
}

const TURN_STYLE: Record<DashboardTrackTurn, TurnStyle> = {
  your_move: {
    token: 'bg-primary/10 text-primary border-transparent font-semibold',
    dot: 'bg-primary',
  },
  waiting: {
    token: 'bg-card text-muted-foreground border-dashed border-muted-foreground/60 font-medium',
    dot: 'border-[1.5px] border-muted-foreground/60 bg-transparent',
  },
  in_progress: {
    token: 'bg-muted-foreground/10 text-muted-foreground border-transparent font-medium',
    dot: 'bg-muted-foreground',
  },
};

function turnText(turn: DashboardTrackTurn, workspaceType: YourMoveWorkspaceType): string {
  if (turn === 'your_move') return PROJECT_TRACK_YOUR_MOVE.toLowerCase();
  if (turn === 'waiting') return PROJECT_TRACK_COPY[workspaceType].waiting.toLowerCase();
  return PROJECT_TRACK_IN_PROGRESS.toLowerCase();
}

function TokenLink({
  token,
  stage,
  workspaceType,
}: Readonly<{
  token: ProjectTrackToken;
  stage: ProjectTrackStage;
  workspaceType: YourMoveWorkspaceType;
}>): React.JSX.Element {
  const style = TURN_STYLE[token.turn];
  const text = turnText(token.turn, workspaceType);
  const summary = `${token.title}: ${text}`;
  const handleClick = (): void => {
    track(DASHBOARD_EVENTS.TRACK_CLICKED, {
      workspace_type: workspaceType,
      stage: stage.key,
      turn: token.turn,
    });
  };

  return (
    <Link
      href={token.href}
      onClick={handleClick}
      data-turn={token.turn}
      title={summary}
      aria-label={token.label === token.title ? summary : `${token.label}, ${summary}`}
      className={cn(
        'focus-visible:ring-ring inline-flex min-h-11 max-w-full items-center gap-[7px] rounded-full border px-2.5 text-[12.5px] focus-visible:ring-2 focus-visible:outline-none md:min-h-7',
        style.token
      )}
    >
      <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', style.dot)} />
      <span className="truncate">{token.label}</span>
    </Link>
  );
}

const NODE_TONE = {
  filled: 'bg-primary text-primary-foreground',
  empty: 'bg-card border-border text-muted-foreground border-[1.5px] border-dashed',
  open: 'bg-card border-muted-foreground/60 text-foreground border-[1.5px]',
} as const;

function StageNode({ stage }: Readonly<{ stage: ProjectTrackStage }>): React.JSX.Element {
  const count = stage.tokens.length;
  let nodeTone: 'filled' | 'empty' | 'open' = 'open';
  if (stage.hasYourMove) nodeTone = 'filled';
  else if (count === 0) nodeTone = 'empty';
  const tone = NODE_TONE[nodeTone];

  return (
    <span
      aria-hidden="true"
      data-tone={nodeTone}
      className={cn(
        'relative z-10 inline-flex size-[30px] shrink-0 items-center justify-center rounded-full text-[12.5px] font-bold',
        tone
      )}
    >
      {count}
    </span>
  );
}

function StageItem({
  stage,
  isLast,
  workspaceType,
}: Readonly<{
  stage: ProjectTrackStage;
  isLast: boolean;
  workspaceType: YourMoveWorkspaceType;
}>): React.JSX.Element {
  const count = stage.tokens.length;
  return (
    <li className="relative grid grid-cols-[30px_minmax(0,1fr)] gap-x-3 pb-4 last:pb-0 md:block md:pr-3 md:pb-0">
      {!isLast && (
        <span
          aria-hidden="true"
          className="bg-border absolute top-[30px] bottom-0 left-[14px] w-0.5 md:top-[14px] md:right-0 md:bottom-auto md:left-[30px] md:h-0.5 md:w-auto"
        />
      )}
      <StageNode stage={stage} />
      <div className="min-w-0 pt-[5px] md:pt-0">
        <span className="text-foreground block text-[13.5px] font-semibold md:mt-2.5">
          {stage.label}
          <span className="sr-only">{`, ${count} ${count === 1 ? 'project' : 'projects'}`}</span>
        </span>
        <div
          className={cn(
            'flex flex-wrap gap-1.5 md:mt-2.5 md:flex-col md:items-start',
            count > 0 && 'mt-2'
          )}
        >
          {count === 0 && (
            <span className="text-muted-foreground hidden text-[12.5px] md:inline">
              {PROJECT_TRACK_NONE}
            </span>
          )}
          {stage.tokens.map((token) => (
            <TokenLink key={token.id} token={token} stage={stage} workspaceType={workspaceType} />
          ))}
        </div>
      </div>
    </li>
  );
}

const LEGEND: readonly DashboardTrackTurn[] = ['your_move', 'waiting', 'in_progress'];

/**
 * The dashboard track: every live project under its stage, each token coloured by whose move
 * it is.
 */
export function ProjectTrack({ view }: Readonly<{ view: ProjectTrackView }>): React.JSX.Element {
  const { workspaceType, stages } = view;
  const copy = PROJECT_TRACK_COPY[workspaceType];
  const legendLabel: Record<DashboardTrackTurn, string> = {
    your_move: PROJECT_TRACK_YOUR_MOVE,
    waiting: copy.waiting,
    in_progress: PROJECT_TRACK_IN_PROGRESS,
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: 'easeOut' }}
      aria-labelledby="project-track-heading"
      data-track={workspaceType}
      className="bg-card border-border mb-4 rounded-2xl border px-4 py-[18px] shadow-sm md:px-[22px] md:pt-5 md:pb-[22px]"
    >
      <div className="mb-[18px] flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2
            id="project-track-heading"
            className="text-foreground text-[17px] font-semibold tracking-tight"
          >
            {copy.title}
          </h2>
          <p className="text-muted-foreground mt-0.5 text-[13px]">{copy.sub}</p>
        </div>
        <ul aria-label="Legend" className="flex flex-wrap gap-3.5">
          {LEGEND.map((turn) => (
            <li key={turn} className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <span
                aria-hidden="true"
                className={cn('size-2 rounded-full', TURN_STYLE[turn].dot)}
              />
              {legendLabel[turn]}
            </li>
          ))}
        </ul>
      </div>
      <ol className="md:grid md:grid-cols-5">
        {stages.map((stage, index) => (
          <StageItem
            key={stage.key}
            stage={stage}
            isLast={index === stages.length - 1}
            workspaceType={workspaceType}
          />
        ))}
      </ol>
    </motion.section>
  );
}
