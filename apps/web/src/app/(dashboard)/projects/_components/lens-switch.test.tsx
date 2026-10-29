import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import { LensSwitch } from './lens-switch';

const mockReplace = vi.fn();
let mockSearch = '';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const trackMock = vi.mocked(track);

describe('LensSwitch', () => {
  beforeEach(() => {
    trackMock.mockClear();
    mockReplace.mockClear();
    mockSearch = '';
  });

  it('shows an Agency tab only when the lens is allowed', () => {
    const { rerender } = render(<LensSwitch lens="client" allowedLenses={['client', 'expert']} />);
    expect(screen.queryByRole('tab', { name: /agency/i })).not.toBeInTheDocument();
    rerender(<LensSwitch lens="client" allowedLenses={['client', 'expert', 'agency']} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Client',
      'Expert',
      'Agency',
    ]);
  });

  it('drops a stale ?agency= when leaving the agency lens', async () => {
    mockSearch = 'lens=agency&agency=ag-2';
    const user = userEvent.setup();
    render(<LensSwitch lens="agency" allowedLenses={['client', 'agency']} />);
    await user.click(screen.getByRole('tab', { name: /client/i }));
    expect(mockReplace).toHaveBeenCalledWith('/projects?lens=client', { scroll: false });
  });

  it('renders nothing when the viewer qualifies for a single lens', () => {
    const { container } = render(<LensSwitch lens="client" allowedLenses={['client']} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one tab per allowed lens when the viewer qualifies for more than one', () => {
    render(<LensSwitch lens="client" allowedLenses={['client', 'expert', 'admin']} />);
    expect(screen.getByRole('tab', { name: /client/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /expert/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /admin/i })).toBeInTheDocument();
  });

  it('marks the active lens as selected', () => {
    render(<LensSwitch lens="expert" allowedLenses={['client', 'expert']} />);
    expect(screen.getByRole('tab', { name: /expert/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /client/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('switches lens via router.replace and fires the analytics event', async () => {
    const user = userEvent.setup();
    render(<LensSwitch lens="client" allowedLenses={['client', 'expert']} />);

    await user.click(screen.getByRole('tab', { name: /expert/i }));

    expect(trackMock).toHaveBeenCalledWith(PROJECTS_INBOX_EVENTS.INBOX_LENS_SWITCHED, {
      from_lens: 'client',
      to_lens: 'expert',
    });
    expect(mockReplace).toHaveBeenCalledWith('/projects?lens=expert', { scroll: false });
  });

  it('does not switch or fire when clicking the already-active lens', async () => {
    const user = userEvent.setup();
    render(<LensSwitch lens="client" allowedLenses={['client', 'expert']} />);

    await user.click(screen.getByRole('tab', { name: /client/i }));

    expect(trackMock).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
