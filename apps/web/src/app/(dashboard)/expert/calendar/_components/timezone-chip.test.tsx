import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { TimezoneChip } from './timezone-chip';

/**
 * Only the browser-zone DETECTION call (`Intl.DateTimeFormat()`, no args, no `new`) is faked.
 * `date-fns-tz`'s own formatting calls (`new Intl.DateTimeFormat(locale, options)`) pass
 * through to the real implementation — a full replacement breaks every formatted label in the
 * component under test.
 */
function mockBrowserTimezone(timeZone: string): void {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
    this: unknown,
    ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
  ) {
    if (args.length === 0) {
      return { resolvedOptions: () => ({ timeZone }) } as Intl.DateTimeFormat;
    }
    return new OriginalDateTimeFormat(...args);
  } as unknown as typeof Intl.DateTimeFormat);
}

describe('TimezoneChip', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the schedule timezone label', () => {
    mockBrowserTimezone('Australia/Melbourne');
    render(<TimezoneChip scheduleTimezone="Australia/Melbourne" />);
    expect(screen.getByText(/Melbourne/i)).toBeInTheDocument();
  });

  it('omits the Info affordance when the browser zone equals the schedule zone', async () => {
    mockBrowserTimezone('Australia/Melbourne');
    render(<TimezoneChip scheduleTimezone="Australia/Melbourne" />);
    await waitFor(() => {
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });
  });

  it('shows the Info affordance, reachable by tap, when the browser zone differs', async () => {
    mockBrowserTimezone('America/New_York');
    const user = userEvent.setup();
    render(<TimezoneChip scheduleTimezone="Australia/Melbourne" />);

    const infoButton = await screen.findByRole('button');
    await user.click(infoButton);

    await waitFor(() => {
      expect(
        screen.getAllByText(/Your device is set to a different timezone/i).length
      ).toBeGreaterThan(0);
    });
  });

  it('the explanation is present as visible text linked via aria-describedby, not hover-only', async () => {
    mockBrowserTimezone('America/New_York');
    render(<TimezoneChip scheduleTimezone="Australia/Melbourne" />);
    const infoButton = await screen.findByRole('button');
    expect(infoButton).toHaveAttribute('aria-describedby', 'calendar-timezone-explanation');
    expect(document.getElementById('calendar-timezone-explanation')?.textContent).toMatch(
      /different timezone/i
    );
  });
});
