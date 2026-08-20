import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DateOverrideConflictWarning } from './date-override-conflict-warning';
import type { AvailabilityConflictReportDto } from '../_types/availability-conflict';

afterEach(() => {
  cleanup();
});

function report(
  overrides: Partial<AvailabilityConflictReportDto> = {}
): AvailabilityConflictReportDto {
  return {
    conflictCount: 1,
    durationDays: 3,
    timezone: 'Australia/Sydney',
    truncated: false,
    conflicts: [
      {
        consultationId: 'c1',
        startAt: '2026-12-24T03:00:00.000Z',
        endAt: '2026-12-24T04:00:00.000Z',
        clientCompanyName: 'Northwind Industrial',
      },
    ],
    ...overrides,
  };
}

describe('DateOverrideConflictWarning', () => {
  it('renders the SINGULAR heading for one conflict', () => {
    render(
      <DateOverrideConflictWarning
        report={report()}
        rangeLabel="24 Dec 2026 – 26 Dec 2026"
        pending={false}
        onConfirm={vi.fn()}
        onBack={vi.fn()}
      />
    );

    expect(screen.getByText('1 session is already booked in these dates')).toBeInTheDocument();
  });

  it('renders the PLURAL heading for multiple conflicts', () => {
    render(
      <DateOverrideConflictWarning
        report={report({ conflictCount: 3 })}
        rangeLabel="24 Dec 2026 – 26 Dec 2026"
        pending={false}
        onConfirm={vi.fn()}
        onBack={vi.fn()}
      />
    );

    expect(screen.getByText('3 sessions are already booked in these dates')).toBeInTheDocument();
  });

  it('renders the client company name for a row that has one', () => {
    render(
      <DateOverrideConflictWarning
        report={report()}
        rangeLabel="24 Dec 2026 – 26 Dec 2026"
        pending={false}
        onConfirm={vi.fn()}
        onBack={vi.fn()}
      />
    );

    expect(screen.getByText(/Northwind Industrial/)).toBeInTheDocument();
  });

  it('renders the time alone, with no placeholder, for a null company', () => {
    render(
      <DateOverrideConflictWarning
        report={report({
          conflicts: [
            {
              consultationId: 'c1',
              startAt: '2026-12-24T03:00:00.000Z',
              endAt: '2026-12-24T04:00:00.000Z',
              clientCompanyName: null,
            },
          ],
        })}
        rangeLabel="24 Dec 2026 – 26 Dec 2026"
        pending={false}
        onConfirm={vi.fn()}
        onBack={vi.fn()}
      />
    );

    expect(screen.queryByText(/·/)).not.toBeInTheDocument();
  });

  it('renders the truncation line when truncated', () => {
    render(
      <DateOverrideConflictWarning
        report={report({ conflictCount: 25, truncated: true })}
        rangeLabel="24 Dec 2026 – 26 Dec 2026"
        pending={false}
        onConfirm={vi.fn()}
        onBack={vi.fn()}
      />
    );

    expect(screen.getByText('+ 24 more sessions')).toBeInTheDocument();
  });

  it('fires onConfirm when "Block dates anyway" is clicked', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <DateOverrideConflictWarning
        report={report()}
        rangeLabel="24 Dec 2026 – 26 Dec 2026"
        pending={false}
        onConfirm={onConfirm}
        onBack={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: /block dates anyway/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('fires onBack when "Choose other dates" is clicked', async () => {
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(
      <DateOverrideConflictWarning
        report={report()}
        rangeLabel="24 Dec 2026 – 26 Dec 2026"
        pending={false}
        onConfirm={vi.fn()}
        onBack={onBack}
      />
    );

    await user.click(screen.getByRole('button', { name: /choose other dates/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while pending', () => {
    render(
      <DateOverrideConflictWarning
        report={report()}
        rangeLabel="24 Dec 2026 – 26 Dec 2026"
        pending
        onConfirm={vi.fn()}
        onBack={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /block dates anyway/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /choose other dates/i })).toBeDisabled();
  });

  // ── C2/R2 — announcement + focus landing ────────────────────────

  it('is announced to assistive tech via role="alertdialog", labelled by the heading (R2)', () => {
    render(
      <DateOverrideConflictWarning
        report={report()}
        rangeLabel="24 Dec 2026 – 26 Dec 2026"
        pending={false}
        onConfirm={vi.fn()}
        onBack={vi.fn()}
      />
    );

    const dialog = screen.getByRole('alertdialog');
    const heading = screen.getByRole('heading', {
      name: '1 session is already booked in these dates',
    });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-labelledby', heading.id);
  });

  it('exposes the count as a real heading, discoverable by heading-navigation (C2)', () => {
    render(
      <DateOverrideConflictWarning
        report={report()}
        rangeLabel="24 Dec 2026 – 26 Dec 2026"
        pending={false}
        onConfirm={vi.fn()}
        onBack={vi.fn()}
      />
    );

    expect(
      screen.getByRole('heading', { name: '1 session is already booked in these dates' })
    ).toBeInTheDocument();
  });

  it('moves focus onto the heading on mount, NOT the destructive button, so a keyboard user lands deterministically (R2)', () => {
    render(
      <DateOverrideConflictWarning
        report={report()}
        rangeLabel="24 Dec 2026 – 26 Dec 2026"
        pending={false}
        onConfirm={vi.fn()}
        onBack={vi.fn()}
      />
    );

    expect(
      screen.getByRole('heading', { name: '1 session is already booked in these dates' })
    ).toHaveFocus();
    expect(screen.getByRole('button', { name: /block dates anyway/i })).not.toHaveFocus();
  });

  it('the focused heading is NOT an activatable element, so a stray Enter there does not fire onConfirm (R2)', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    render(
      <DateOverrideConflictWarning
        report={report()}
        rangeLabel="24 Dec 2026 – 26 Dec 2026"
        pending={false}
        onConfirm={onConfirm}
        onBack={vi.fn()}
      />
    );

    // Mount-time focus already landed on the heading (asserted above). This is the element a
    // key-repeated Enter (carried over from clicking "Block these dates" a moment earlier)
    // would actually be delivered to — the regression test at the popover level
    // (date-override-add-popover.test.tsx, R2) drives the full key-repeat scenario; this pins
    // the piece that makes it safe: the heading has no click/keydown handler, so Enter here is
    // a no-op, unlike the button it replaced as the focus target.
    await user.keyboard('{Enter}');

    expect(onConfirm).not.toHaveBeenCalled();
  });
});
