import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { PartyDomainWithCreator } from '@balo/db';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/app/(dashboard)/settings/team/_actions/remove-domain', () => ({
  removePartyDomain: vi.fn(),
}));

import { DomainRow, attributionText, creatorName } from './domain-row';
import { removePartyDomain } from '@/app/(dashboard)/settings/team/_actions/remove-domain';
import { toast } from 'sonner';

const removeMock = vi.mocked(removePartyDomain);
const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);

const PARTY_ID = '22222222-2222-4222-8222-222222222222';

function makeRow(over: Partial<PartyDomainWithCreator> = {}): PartyDomainWithCreator {
  return {
    id: 'd1',
    domain: 'northwind.com',
    source: 'auto_captured',
    createdAt: new Date('2020-01-01T00:00:00Z'),
    createdBy: { id: 'u1', firstName: 'Ada', lastName: 'Lovelace' },
    ...over,
  };
}

function renderRow(
  over: { row?: Partial<PartyDomainWithCreator>; isLast?: boolean; firstMention?: boolean } = {}
): void {
  render(
    <DomainRow
      row={makeRow(over.row)}
      firstMention={over.firstMention ?? true}
      partyType="company"
      partyId={PARTY_ID}
      partyName="Northwind"
      isLast={over.isLast ?? false}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('attributionText / creatorName', () => {
  it('is source-aware and appends "@ party" on first mention only', () => {
    expect(
      attributionText(
        'auto_captured',
        { firstName: 'Ada', lastName: 'Lovelace' },
        true,
        'Northwind'
      )
    ).toBe('Captured from Ada Lovelace @ Northwind');
    expect(
      attributionText('admin_added', { firstName: 'Jordan', lastName: 'Ellis' }, false, 'Northwind')
    ).toBe('Added by Jordan Ellis');
  });

  it('falls back to a neutral name and drops the suffix when unattributed', () => {
    expect(creatorName(null)).toBe('a teammate');
    expect(attributionText('admin_added', null, true, 'Northwind')).toBe('Added by a teammate');
  });
});

describe('DomainRow', () => {
  it('renders the domain, the auto-captured source badge, and attribution', () => {
    renderRow();
    expect(screen.getByText('northwind.com')).toBeInTheDocument();
    expect(screen.getByText('Auto-captured')).toBeInTheDocument();
    expect(screen.getByText('Captured from Ada Lovelace @ Northwind')).toBeInTheDocument();
  });

  it('opens an inline confirm with the standard caution when not the last domain', async () => {
    const user = userEvent.setup();
    renderRow({ isLast: false });

    await user.click(screen.getByRole('button', { name: /remove northwind.com/i }));

    expect(screen.getByText('Remove northwind.com?')).toBeInTheDocument();
    expect(screen.getByText(/new signups on this domain won't be recognised/i)).toBeInTheDocument();
  });

  it('shows the amber last-domain caution when isLast', async () => {
    const user = userEvent.setup();
    renderRow({ isLast: true });

    await user.click(screen.getByRole('button', { name: /remove northwind.com/i }));

    expect(screen.getByText(/turns off join by domain entirely/i)).toBeInTheDocument();
  });

  it('cancels the confirm with Keep', async () => {
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole('button', { name: /remove northwind.com/i }));
    await user.click(screen.getByRole('button', { name: /keep/i }));

    expect(screen.queryByText('Remove northwind.com?')).not.toBeInTheDocument();
  });

  it('calls the remove action and toasts on success', async () => {
    removeMock.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole('button', { name: /remove northwind.com/i }));
    await user.click(screen.getByRole('button', { name: /^remove$/i }));

    await waitFor(() =>
      expect(removeMock).toHaveBeenCalledWith({
        partyType: 'company',
        partyId: PARTY_ID,
        domainId: 'd1',
      })
    );
    expect(toastSuccess).toHaveBeenCalledWith('Domain removed');
  });

  it('toasts an error and re-closes the confirm on failure', async () => {
    removeMock.mockResolvedValue({ success: false, error: 'This domain could not be found.' });
    const user = userEvent.setup();
    renderRow();

    await user.click(screen.getByRole('button', { name: /remove northwind.com/i }));
    await user.click(screen.getByRole('button', { name: /^remove$/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('This domain could not be found.'));
    expect(screen.queryByText('Remove northwind.com?')).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <DomainRow
        row={makeRow({ source: 'admin_added' })}
        firstMention
        partyType="company"
        partyId={PARTY_ID}
        partyName="Northwind"
        isLast={false}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
