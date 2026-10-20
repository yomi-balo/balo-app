import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

vi.mock('./your-move', () => ({
  YourMove: ({
    data,
    workspaceType,
  }: {
    data: { kind: string; cards: unknown[]; rows?: unknown };
    workspaceType: string;
  }) => (
    <div data-testid="your-move" data-has-rows={String('rows' in data)}>
      {`${workspaceType}:${data.kind}:${data.cards.length}`}
    </div>
  ),
}));

vi.mock('./project-track', () => ({
  ProjectTrack: ({ view }: { view: { workspaceType: string; stages: unknown[] } }) => (
    <div data-testid="project-track">{`${view.workspaceType}:${view.stages.length}`}</div>
  ),
}));

const mockLoad = vi.fn();
vi.mock('../_lib/load-client-your-move', () => ({
  loadClientYourMove: (...args: unknown[]) => mockLoad(...args),
}));

vi.mock('@/lib/logging', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { CompanyYourMoveSlot } from './company-your-move-slot';
import { log } from '@/lib/logging';
import type { SessionUser } from '@/lib/auth/session';

const USER = { id: 'u-1' } as SessionUser;

const LIVE_ROWS = [
  {
    id: 'p1',
    href: '/projects/p1',
    title: 'Project 1',
    companyName: 'Northwind',
    stage: 'eoi',
    needsYou: true,
    kind: 'request',
  },
];
const PROPS = { user: USER, companyId: 'co-1', companyName: 'Northwind' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CompanyYourMoveSlot', () => {
  it('loads for the company and renders the company rail with the cards', async () => {
    mockLoad.mockResolvedValue({ cards: [{ id: 'c1' }, { id: 'c2' }], rows: LIVE_ROWS });
    render(await CompanyYourMoveSlot(PROPS));
    expect(mockLoad).toHaveBeenCalledWith({
      user: USER,
      companyId: 'co-1',
      companyName: 'Northwind',
    });
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('your-move')).toHaveTextContent('company:ready:2');
    expect(screen.getByTestId('project-track')).toHaveTextContent('company:5');
    expect(screen.getByTestId('your-move')).toHaveAttribute('data-has-rows', 'false');
  });

  it('renders no track when the read has no live rows', async () => {
    mockLoad.mockResolvedValue({ cards: [], rows: [] });
    render(await CompanyYourMoveSlot(PROPS));
    expect(screen.getByTestId('your-move')).toBeInTheDocument();
    expect(screen.queryByTestId('project-track')).not.toBeInTheDocument();
  });

  it('renders the error state with no cards, and logs, when the read throws', async () => {
    mockLoad.mockRejectedValue(new Error('boom'));
    render(await CompanyYourMoveSlot(PROPS));
    expect(screen.getByTestId('your-move')).toHaveTextContent('company:error:0');
    expect(screen.queryByTestId('project-track')).not.toBeInTheDocument();
    expect(log.error).toHaveBeenCalledWith(
      'Dashboard your move read failed',
      expect.objectContaining({ userId: 'u-1', companyId: 'co-1', error: 'boom' })
    );
  });
});
