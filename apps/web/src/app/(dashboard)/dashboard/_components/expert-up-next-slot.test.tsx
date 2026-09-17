import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

vi.mock('./up-next-card', () => ({
  UpNextCard: ({ data }: { data: { kind: string } }) => (
    <div data-testid="up-next-card">{data.kind}</div>
  ),
}));
vi.mock('./ghost-consultations-card', () => ({
  GhostConsultationsCard: () => <div data-testid="ghost-card" />,
}));

const mockLoadExpertUpNext = vi.fn();
vi.mock('../_lib/load-up-next', () => ({
  loadExpertUpNext: (...args: unknown[]) => mockLoadExpertUpNext(...args),
}));

vi.mock('@/lib/logging', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { ExpertUpNextSlot } from './expert-up-next-slot';
import { log } from '@/lib/logging';

const BASE = { userId: 'u-1', expertProfileId: 'profile-1', footerLinks: [] };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ExpertUpNextSlot (BAL-566 R2)', () => {
  it('renders the ghost card when there are no rows and setup is incomplete', async () => {
    mockLoadExpertUpNext.mockResolvedValue([]);
    const element = await ExpertUpNextSlot({ ...BASE, checklistStatus: { allComplete: false } });
    render(element);
    expect(screen.getByTestId('ghost-card')).toBeInTheDocument();
    expect(screen.queryByTestId('up-next-card')).toBeNull();
  });

  it('renders the card when there are rows, even though setup is incomplete (bookings win)', async () => {
    mockLoadExpertUpNext.mockResolvedValue([{ meetingId: 'm-1' }]);
    const element = await ExpertUpNextSlot({ ...BASE, checklistStatus: { allComplete: false } });
    render(element);
    expect(screen.getByTestId('up-next-card')).toBeInTheDocument();
    expect(screen.queryByTestId('ghost-card')).toBeNull();
  });

  it('renders the card (Empty state) when setup is complete, even with zero rows', async () => {
    mockLoadExpertUpNext.mockResolvedValue([]);
    const element = await ExpertUpNextSlot({ ...BASE, checklistStatus: { allComplete: true } });
    render(element);
    expect(screen.getByTestId('up-next-card')).toBeInTheDocument();
  });

  it('renders the card error state (never the ghost) when the read throws', async () => {
    mockLoadExpertUpNext.mockRejectedValue(new Error('boom'));
    const element = await ExpertUpNextSlot({ ...BASE, checklistStatus: { allComplete: false } });
    render(element);
    expect(screen.getByTestId('up-next-card')).toHaveTextContent('error');
    expect(screen.queryByTestId('ghost-card')).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      'Dashboard up next read failed',
      expect.objectContaining({ userId: 'u-1', expertProfileId: 'profile-1' })
    );
  });

  it('a null checklist (read failed) with zero rows still shows the ghost', async () => {
    mockLoadExpertUpNext.mockResolvedValue([]);
    const element = await ExpertUpNextSlot({ ...BASE, checklistStatus: null });
    render(element);
    expect(screen.getByTestId('ghost-card')).toBeInTheDocument();
  });
});
