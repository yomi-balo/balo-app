import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@/test/utils';
import { axe } from '@/test/axe';
import { track, DASHBOARD_EVENTS } from '@/lib/analytics';
import {
  PROJECT_TRACK_COPY,
  type ProjectTrackStage,
  type ProjectTrackToken,
  type ProjectTrackView,
} from '../_lib/your-move-view-types';
import { ProjectTrack } from './project-track';

function token(id: string, over: Partial<ProjectTrackToken> = {}): ProjectTrackToken {
  return {
    id,
    label: `Label ${id}`,
    title: `Title ${id}`,
    href: `/projects/${id}`,
    turn: 'waiting',
    ...over,
  };
}

function stage(
  key: ProjectTrackStage['key'],
  label: string,
  tokens: ProjectTrackToken[] = []
): ProjectTrackStage {
  return { key, label, tokens, hasYourMove: tokens.some((t) => t.turn === 'your_move') };
}

const EXPERT_VIEW: ProjectTrackView = {
  workspaceType: 'expert',
  stages: [
    stage('invited', 'Invited', [token('a', { turn: 'your_move' })]),
    stage('eoi', 'Interest sent'),
    stage('proposal', 'Proposal', [token('b'), token('c')]),
    stage('kickoff', 'Kickoff'),
    stage('delivery', 'Delivery', [token('d', { turn: 'in_progress' })]),
  ],
};

const COMPANY_VIEW: ProjectTrackView = {
  workspaceType: 'company',
  stages: [
    stage('matching', 'Matching', [token('m', { label: 'Same', title: 'Same' })]),
    stage('interest', 'Interest'),
    stage('proposal', 'Proposals'),
    stage('kickoff', 'Kickoff'),
    stage('delivery', 'Delivery'),
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProjectTrack', () => {
  it('renders the title, sub and legend for the lens', () => {
    render(<ProjectTrack view={EXPERT_VIEW} />);
    expect(
      screen.getByRole('heading', { name: PROJECT_TRACK_COPY.expert.title })
    ).toBeInTheDocument();
    expect(screen.getByText(PROJECT_TRACK_COPY.expert.sub)).toBeInTheDocument();
    const legend = within(screen.getByRole('list', { name: 'Legend' }));
    expect(legend.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Your move',
      'Waiting on client',
      'In progress',
    ]);
  });

  it('uses the company waiting copy on the company lens', () => {
    render(<ProjectTrack view={COMPANY_VIEW} />);
    expect(screen.getByText('Waiting on others')).toBeInTheDocument();
  });

  it('renders every stage label with its count, and None for an empty stage', () => {
    render(<ProjectTrack view={EXPERT_VIEW} />);
    for (const label of ['Invited', 'Interest sent', 'Proposal', 'Kickoff', 'Delivery']) {
      expect(screen.getByText(label, { exact: false })).toBeInTheDocument();
    }
    expect(screen.getByText(', 2 projects')).toBeInTheDocument();
    expect(screen.getAllByText(', 1 project')).toHaveLength(2);
    expect(screen.getAllByText('None')).toHaveLength(2);
  });

  it('tones each stage node: filled for your move, dashed when empty, open otherwise', () => {
    const { container } = render(<ProjectTrack view={EXPERT_VIEW} />);
    const tones = [...container.querySelectorAll('[data-tone]')].map((n) =>
      n.getAttribute('data-tone')
    );
    expect(tones).toEqual(['filled', 'empty', 'open', 'empty', 'open']);
  });

  it('links each token to its href with an accessible name that carries whose move it is', () => {
    render(<ProjectTrack view={EXPERT_VIEW} />);
    const mine = screen.getByRole('link', { name: 'Label a, Title a: your move' });
    expect(mine).toHaveAttribute('href', '/projects/a');
    expect(mine).toHaveAttribute('data-turn', 'your_move');
    expect(
      screen.getByRole('link', { name: 'Label b, Title b: waiting on client' })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Label d, Title d: in progress' })).toBeInTheDocument();
  });

  it('does not double the name when the label equals the title', () => {
    render(<ProjectTrack view={COMPANY_VIEW} />);
    expect(screen.getByRole('link', { name: 'Same: waiting on others' })).toBeInTheDocument();
  });

  it('tracks a click with workspace, stage and turn only, and leaves navigation alone', async () => {
    const user = userEvent.setup();
    render(<ProjectTrack view={EXPERT_VIEW} />);
    await user.click(screen.getByRole('link', { name: 'Label b, Title b: waiting on client' }));
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(DASHBOARD_EVENTS.TRACK_CLICKED, {
      workspace_type: 'expert',
      stage: 'proposal',
      turn: 'waiting',
    });
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<ProjectTrack view={EXPERT_VIEW} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
