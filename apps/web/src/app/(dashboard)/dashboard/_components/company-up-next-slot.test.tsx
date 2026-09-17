import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

vi.mock('./up-next-card', () => ({
  UpNextCard: ({ data, subtitle }: { data: { kind: string }; subtitle: string }) => (
    <div data-testid="up-next-card">
      {data.kind}::{subtitle}
    </div>
  ),
}));

const mockLoadCompanyUpNext = vi.fn();
vi.mock('../_lib/load-up-next', () => ({
  loadCompanyUpNext: (...args: unknown[]) => mockLoadCompanyUpNext(...args),
}));

vi.mock('@/lib/logging', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { CompanyUpNextSlot } from './company-up-next-slot';
import { log } from '@/lib/logging';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CompanyUpNextSlot', () => {
  it('renders nothing when the loader returns null (R1 omit)', async () => {
    mockLoadCompanyUpNext.mockResolvedValue(null);
    const element = await CompanyUpNextSlot({
      actorUserId: 'u-1',
      companyId: 'co-1',
      companyName: 'Northwind',
      footerLinks: [],
    });
    expect(element).toBeNull();
  });

  it('renders the card in the ready state with the company subtitle', async () => {
    mockLoadCompanyUpNext.mockResolvedValue([]);
    const element = await CompanyUpNextSlot({
      actorUserId: 'u-1',
      companyId: 'co-1',
      companyName: 'Northwind',
      footerLinks: [],
    });
    if (element === null) throw new Error('expected a rendered element');
    render(element);
    expect(screen.getByTestId('up-next-card')).toHaveTextContent(
      'ready::Meetings across Northwind’s cases and projects'
    );
  });

  it('renders the error card and logs when the loader throws', async () => {
    mockLoadCompanyUpNext.mockRejectedValue(new Error('boom'));
    const element = await CompanyUpNextSlot({
      actorUserId: 'u-1',
      companyId: 'co-1',
      companyName: 'Northwind',
      footerLinks: [],
    });
    if (element === null) throw new Error('expected a rendered element');
    render(element);
    expect(screen.getByTestId('up-next-card')).toHaveTextContent('error');
    expect(log.error).toHaveBeenCalledWith(
      'Dashboard up next read failed',
      expect.objectContaining({ userId: 'u-1', companyId: 'co-1', error: 'boom' })
    );
  });
});
