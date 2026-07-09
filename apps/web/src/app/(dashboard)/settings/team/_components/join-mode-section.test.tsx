import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../_actions/set-join-mode', () => ({ setCompanyJoinMode: vi.fn() }));

import { JoinModeSection } from './join-mode-section';
import { setCompanyJoinMode } from '../_actions/set-join-mode';
import { toast } from 'sonner';

const setModeMock = vi.mocked(setCompanyJoinMode);
const toastSuccess = vi.mocked(toast.success);
const toastError = vi.mocked(toast.error);

const COMPANY_ID = '22222222-2222-4222-8222-222222222222';

function renderSection(over: Partial<Parameters<typeof JoinModeSection>[0]> = {}): void {
  render(
    <JoinModeSection
      companyId={COMPANY_ID}
      initialMode={over.initialMode ?? 'auto'}
      lastChangedByName={over.lastChangedByName ?? null}
      lastChangedAt={over.lastChangedAt ?? null}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('JoinModeSection', () => {
  it('renders the three modes with the auto Default tag and the current selection', () => {
    renderSection({ initialMode: 'request' });
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /request to join/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('radio', { name: /automatic/i })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('selecting a mode calls the action and toasts success', async () => {
    setModeMock.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderSection({ initialMode: 'auto' });

    await user.click(screen.getByRole('radio', { name: /request to join/i }));

    await waitFor(() =>
      expect(setModeMock).toHaveBeenCalledWith({ companyId: COMPANY_ID, mode: 'request' })
    );
    expect(toastSuccess).toHaveBeenCalledWith('Join mode updated');
  });

  it('rolls back the selection and toasts an error on failure', async () => {
    setModeMock.mockResolvedValue({ success: false, error: 'Could not update join mode.' });
    const user = userEvent.setup();
    renderSection({ initialMode: 'auto' });

    await user.click(screen.getByRole('radio', { name: /off/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not update join mode.'));
    // Reverted to the original selection.
    expect(screen.getByRole('radio', { name: /automatic/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('renders the "Last changed by" line when provided', () => {
    renderSection({
      lastChangedByName: 'Jordan Ellis',
      lastChangedAt: new Date('2020-07-03T00:00:00Z'),
    });
    expect(screen.getByText(/last changed by jordan ellis/i)).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <JoinModeSection
        companyId={COMPANY_ID}
        initialMode="auto"
        lastChangedByName="Jordan Ellis"
        lastChangedAt={new Date('2020-07-03T00:00:00Z')}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
