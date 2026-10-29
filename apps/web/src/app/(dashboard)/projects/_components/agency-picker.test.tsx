import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import { AgencyPicker } from './agency-picker';

const mockReplace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => new URLSearchParams('lens=agency&agency=ag-1'),
}));

beforeAll(() => {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
  Element.prototype.scrollIntoView ??= () => undefined;
});

const CLOUDLINE = { id: 'ag-1', name: 'Cloudline Partners', liveCount: 4 };
const AGENCIES = [CLOUDLINE, { id: 'ag-2', name: 'Zenith', liveCount: 0 }];

describe('AgencyPicker', () => {
  beforeEach(() => {
    vi.mocked(track).mockClear();
    mockReplace.mockClear();
  });

  it('renders nothing for a single agency', () => {
    const { container } = render(<AgencyPicker agencies={[CLOUDLINE]} selectedId="ag-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the selected agency and lists each with its live count', async () => {
    const user = userEvent.setup();
    render(<AgencyPicker agencies={AGENCIES} selectedId="ag-1" />);
    const trigger = screen.getByRole('combobox', { name: 'Agency: Cloudline Partners' });
    expect(trigger).toHaveTextContent('Cloudline Partners');

    await user.click(trigger);
    expect(await screen.findByRole('option', { name: /zenith/i })).toHaveTextContent('Zenith0');
  });

  it('writes the agency to the URL and tracks the count, no ids', async () => {
    const user = userEvent.setup();
    render(<AgencyPicker agencies={AGENCIES} selectedId="ag-1" />);
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /zenith/i }));

    expect(mockReplace).toHaveBeenCalledWith('/projects?lens=agency&agency=ag-2', {
      scroll: false,
    });
    expect(track).toHaveBeenCalledWith(PROJECTS_INBOX_EVENTS.INBOX_AGENCY_SWITCHED, {
      agency_count: 2,
    });
  });

  it('does nothing when the current agency is re-picked', async () => {
    const user = userEvent.setup();
    render(<AgencyPicker agencies={AGENCIES} selectedId="ag-1" />);
    await user.click(screen.getByRole('combobox'));
    await user.click(await screen.findByRole('option', { name: /cloudline/i }));
    expect(mockReplace).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });
});
