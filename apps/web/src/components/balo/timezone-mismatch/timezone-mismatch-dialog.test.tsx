import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SCHEDULE_EVENTS } from '@balo/analytics/events';
import { track } from '@/lib/analytics';
import { axe } from '@/test/axe';
import type { TimezoneImpactReportDto } from '@/app/(dashboard)/expert/settings/_types/timezone-impact';
import { TimezoneMismatchDialog } from './timezone-mismatch-dialog';

const mockGetImpact = vi.fn();
vi.mock('@/app/(dashboard)/expert/settings/_actions/get-timezone-impact', () => ({
  getTimezoneImpactAction: (...args: unknown[]) => mockGetImpact(...args),
}));

const SYDNEY = 'Australia/Sydney';
const LONDON = 'Europe/London';
const NINE_TO_FIVE = { startTime: '09:00', endTime: '17:00' };

function report(count: number, nextTimeOff: TimezoneImpactReportDto['nextTimeOff'] = null) {
  const affected = Array.from({ length: Math.min(count, 20) }, (_, i) => ({
    consultationId: `c${i + 1}`,
    startAt: `2026-07-${String(14 + i).padStart(2, '0')}T00:00:00.000Z`,
    endAt: `2026-07-${String(14 + i).padStart(2, '0')}T01:00:00.000Z`,
    clientCompanyName: `Client ${i + 1}`,
  }));
  return { timezone: LONDON, affectedCount: count, truncated: false, affected, nextTimeOff };
}

interface Props {
  open?: boolean;
  source?: 'detected' | 'manual';
  onKeep?: () => void;
  onSwitch?: () => void;
}

function renderDialog({ open = true, source = 'detected', onKeep, onSwitch }: Props = {}) {
  const handlers = { onKeep: onKeep ?? vi.fn(), onSwitch: onSwitch ?? vi.fn() };
  const view = render(
    <TimezoneMismatchDialog
      open={open}
      source={source}
      expertProfileId="expert-1"
      fromTimezone={SYDNEY}
      toTimezone={LONDON}
      commonRange={NINE_TO_FIVE}
      {...handlers}
    />
  );
  return { ...view, ...handlers };
}

describe('TimezoneMismatchDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetImpact.mockResolvedValue(report(0));
  });

  it('heads a detected prompt with both cities', async () => {
    renderDialog({ source: 'detected' });
    expect(
      await screen.findByRole('alertdialog', {
        name: 'You’re in London, but your hours are set in Sydney time',
      })
    ).toBeInTheDocument();
  });

  it('heads a manual prompt as a question about the new zone', async () => {
    renderDialog({ source: 'manual' });
    expect(
      await screen.findByRole('alertdialog', { name: 'Switch your hours to London time?' })
    ).toBeInTheDocument();
  });

  it('shows the travel hint only for a detected prompt', async () => {
    const detected = renderDialog({ source: 'detected' });
    expect(await screen.findByText(/Travelling but still working/)).toBeInTheDocument();
    detected.unmount();

    renderDialog({ source: 'manual' });
    await screen.findByRole('alertdialog');
    expect(screen.queryByText(/Travelling but still working/)).not.toBeInTheDocument();
  });

  it('describes the hours in both zones', async () => {
    renderDialog();
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => {
      expect(dialog).toHaveAccessibleDescription(/Your 9:00 am – 5:00 pm Sydney hours are/);
    });
    expect(screen.getByText('If you switch to London time')).toBeInTheDocument();
    expect(
      screen.getByText('Busy times from your connected calendar wouldn’t change.')
    ).toBeInTheDocument();
  });

  it('gives Keep initial focus', async () => {
    renderDialog();
    const keep = await screen.findByRole('button', { name: 'Keep Sydney hours' });
    await waitFor(() => expect(keep).toHaveFocus());
  });

  it('gives Keep and Switch equal weight (both outline)', async () => {
    renderDialog();
    const keep = await screen.findByRole('button', { name: 'Keep Sydney hours' });
    const switchBtn = screen.getByRole('button', { name: 'Switch to London time' });
    expect(keep.className).toContain('border');
    expect(switchBtn.className).toContain('border');
    expect(switchBtn.className).not.toContain('bg-primary ');
  });

  it('Keep resolves as kept, not via escape, and reports the check result', async () => {
    mockGetImpact.mockResolvedValue(report(2));
    const user = userEvent.setup();
    const { onKeep, onSwitch } = renderDialog();
    await screen.findByText(/2 upcoming consultations would fall outside/);

    await user.click(screen.getByRole('button', { name: 'Keep Sydney hours' }));

    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onSwitch).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(SCHEDULE_EVENTS.TIMEZONE_MISMATCH_RESOLVED, {
      expert_id: 'expert-1',
      from_timezone: SYDNEY,
      to_timezone: LONDON,
      source: 'detected',
      action: 'kept',
      via_escape: false,
      affected_consultations: 2,
    });
  });

  it('Escape keeps, flagged via_escape', async () => {
    const user = userEvent.setup();
    const { onKeep, onSwitch } = renderDialog();
    await screen.findByRole('alertdialog');

    await user.keyboard('{Escape}');

    expect(onKeep).toHaveBeenCalledTimes(1);
    expect(onSwitch).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(
      SCHEDULE_EVENTS.TIMEZONE_MISMATCH_RESOLVED,
      expect.objectContaining({ action: 'kept', via_escape: true })
    );
  });

  it('Switch resolves once as switched and does not also keep', async () => {
    const user = userEvent.setup();
    const { onKeep, onSwitch } = renderDialog({ source: 'manual' });
    await screen.findByRole('alertdialog');

    await user.click(screen.getByRole('button', { name: 'Switch to London time' }));

    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onKeep).not.toHaveBeenCalled();
    const resolved = vi
      .mocked(track)
      .mock.calls.filter(([event]) => event === SCHEDULE_EVENTS.TIMEZONE_MISMATCH_RESOLVED);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.[1]).toEqual(
      expect.objectContaining({ action: 'switched', via_escape: false, source: 'manual' })
    );
  });

  it('tracks SHOWN once per opening, not per re-render', async () => {
    const { rerender, onKeep, onSwitch } = renderDialog();
    await screen.findByRole('alertdialog');
    const props = {
      source: 'detected' as const,
      expertProfileId: 'expert-1',
      fromTimezone: SYDNEY,
      toTimezone: LONDON,
      commonRange: NINE_TO_FIVE,
      onKeep,
      onSwitch,
    };
    rerender(<TimezoneMismatchDialog open {...props} />);

    const shown = () =>
      vi
        .mocked(track)
        .mock.calls.filter(([event]) => event === SCHEDULE_EVENTS.TIMEZONE_MISMATCH_SHOWN);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]?.[1]).toEqual({
      expert_id: 'expert-1',
      from_timezone: SYDNEY,
      to_timezone: LONDON,
      source: 'detected',
    });

    rerender(<TimezoneMismatchDialog open={false} {...props} />);
    rerender(<TimezoneMismatchDialog open {...props} />);
    await waitFor(() => expect(shown()).toHaveLength(2));
  });

  it('does not check or track while closed', () => {
    renderDialog({ open: false });
    expect(mockGetImpact).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  describe('consultation check', () => {
    it('shows the checking state while Switch stays enabled, and reports null affected', async () => {
      mockGetImpact.mockReturnValue(new Promise(() => undefined));
      const user = userEvent.setup();
      const { onSwitch } = renderDialog();

      expect(await screen.findByText('Checking your upcoming consultations…')).toBeInTheDocument();
      const switchBtn = screen.getByRole('button', { name: 'Switch to London time' });
      expect(switchBtn).toBeEnabled();

      await user.click(switchBtn);
      expect(onSwitch).toHaveBeenCalledTimes(1);
      expect(track).toHaveBeenCalledWith(
        SCHEDULE_EVENTS.TIMEZONE_MISMATCH_RESOLVED,
        expect.objectContaining({ affected_consultations: null })
      );
    });

    it('asks about the proposed zone', async () => {
      renderDialog();
      await waitFor(() => expect(mockGetImpact).toHaveBeenCalledWith({ timezone: LONDON }));
    });

    it('reassures when nothing is affected', async () => {
      renderDialog();
      expect(
        await screen.findByText(
          'None of your upcoming consultations would fall outside your new hours.'
        )
      ).toBeInTheDocument();
    });

    it('lists two affected consultations with their companies', async () => {
      mockGetImpact.mockResolvedValue(report(2));
      renderDialog();

      expect(
        await screen.findByText('2 upcoming consultations would fall outside your new hours.')
      ).toBeInTheDocument();
      expect(screen.getByText('Client 1')).toBeInTheDocument();
      expect(screen.getByText('Client 2')).toBeInTheDocument();
      expect(screen.queryByText(/and \d+ more/)).not.toBeInTheDocument();
      expect(screen.getByText('Nothing is moved or cancelled for you.')).toBeInTheDocument();
    });

    it('uses the singular for one affected consultation', async () => {
      mockGetImpact.mockResolvedValue(report(1));
      renderDialog();

      expect(
        await screen.findByText('1 upcoming consultation would fall outside your new hours.')
      ).toBeInTheDocument();
      expect(screen.getByText(/It would stay/)).toBeInTheDocument();
    });

    it('shows three rows and "and 4 more" for seven', async () => {
      mockGetImpact.mockResolvedValue(report(7));
      renderDialog();

      await screen.findByText('7 upcoming consultations would fall outside your new hours.');
      const items = within(screen.getByRole('alertdialog')).getAllByRole('listitem');
      expect(items).toHaveLength(4);
      expect(screen.getByText('and 4 more')).toBeInTheDocument();
      expect(screen.queryByText('Client 4')).not.toBeInTheDocument();
    });

    it('omits a company that could not be resolved', async () => {
      mockGetImpact.mockResolvedValue({
        ...report(1),
        affected: [
          {
            consultationId: 'c1',
            startAt: '2026-07-14T00:00:00.000Z',
            endAt: '2026-07-14T01:00:00.000Z',
            clientCompanyName: null,
          },
        ],
      });
      renderDialog();

      await screen.findByText(/1 upcoming consultation would/);
      expect(screen.queryByText(/Client 1/)).not.toBeInTheDocument();
    });

    it('fails open when the check resolves null: failed copy, Switch enabled, null affected', async () => {
      mockGetImpact.mockResolvedValue(null);
      const user = userEvent.setup();
      renderDialog();

      expect(
        await screen.findByText(
          'We couldn’t check your upcoming consultations. Nothing that’s booked would move either way.'
        )
      ).toBeInTheDocument();
      const switchBtn = screen.getByRole('button', { name: 'Switch to London time' });
      expect(switchBtn).toBeEnabled();

      await user.click(switchBtn);
      expect(track).toHaveBeenCalledWith(
        SCHEDULE_EVENTS.TIMEZONE_MISMATCH_RESOLVED,
        expect.objectContaining({ action: 'switched', affected_consultations: null })
      );
    });

    it('fails open when the action rejects', async () => {
      mockGetImpact.mockRejectedValue(new Error('network'));
      renderDialog();

      expect(
        await screen.findByText(/We couldn’t check your upcoming consultations/)
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Switch to London time' })).toBeEnabled();
    });

    it('shows the next time-off block only when one is upcoming', async () => {
      mockGetImpact.mockResolvedValue(
        report(0, { startDate: '2026-12-24', endDate: '2027-01-02' })
      );
      const withBlock = renderDialog();
      expect(
        await screen.findByText('Your time off (24 Dec – 2 Jan) would be read in London time too.')
      ).toBeInTheDocument();
      withBlock.unmount();

      mockGetImpact.mockResolvedValue(report(0));
      renderDialog();
      await screen.findByText(/None of your upcoming consultations/);
      expect(screen.queryByText(/Your time off/)).not.toBeInTheDocument();
    });

    it('ignores a check that resolves after the dialog closed', async () => {
      let resolve: (value: TimezoneImpactReportDto) => void = () => undefined;
      mockGetImpact.mockReturnValue(
        new Promise<TimezoneImpactReportDto>((r) => {
          resolve = r;
        })
      );
      const { rerender, onKeep, onSwitch } = renderDialog();
      await screen.findByText('Checking your upcoming consultations…');

      rerender(
        <TimezoneMismatchDialog
          open={false}
          source="detected"
          expertProfileId="expert-1"
          fromTimezone={SYDNEY}
          toTimezone={LONDON}
          commonRange={NINE_TO_FIVE}
          onKeep={onKeep}
          onSwitch={onSwitch}
        />
      );
      resolve(report(3));

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    });
  });

  it('has no axe violations', async () => {
    mockGetImpact.mockResolvedValue(report(2, { startDate: '2026-12-24', endDate: '2027-01-02' }));
    renderDialog();
    await screen.findByText(/2 upcoming consultations/);

    expect(await axe(document.body)).toHaveNoViolations();
  });
});
