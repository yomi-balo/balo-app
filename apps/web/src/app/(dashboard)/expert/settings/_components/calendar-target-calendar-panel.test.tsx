import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CalendarTargetCalendarPanel } from './calendar-target-calendar-panel';
import type { CalendarConnection, SubCalendar } from '../_types/calendar';

const makeSubCalendar = (overrides: Partial<SubCalendar> = {}): SubCalendar => ({
  id: 'cal-1',
  name: 'Primary',
  provider: 'google',
  primary: true,
  conflictChecking: true,
  ...overrides,
});

const makeConnection = (overrides: Partial<CalendarConnection> = {}): CalendarConnection => ({
  provider: 'google',
  credentialStatus: 'ACTIVE',
  providerEmail: 'dana@example.com',
  lastSyncedAt: null,
  targetCalendarId: 'cal-1',
  subCalendars: [makeSubCalendar()],
  isBookingTarget: true,
  ...overrides,
});

describe('CalendarTargetCalendarPanel', () => {
  // ── Description copy — one branch, one full-string test each (BAL-576) ──────

  it('TARGET branch: this connection IS the booking target', () => {
    const connection = makeConnection({ isBookingTarget: true });
    render(
      <CalendarTargetCalendarPanel
        connection={connection}
        provider="google"
        pending={false}
        bookingTarget={connection}
        onChange={vi.fn()}
      />
    );
    const trigger = screen.getByRole('combobox', { name: 'Where bookings go' });
    expect(trigger.id).toMatch(/^target-calendar-google-/);
    expect(trigger).toHaveAccessibleDescription(
      'Confirmed consultations are added to this calendar. We start with your primary one — change it any time.'
    );
  });

  it('STANDBY branch (3b, a calendar already picked here), target email known: names the target account with its email, and the takeover sentence stays', () => {
    const target = makeConnection({
      provider: 'microsoft',
      providerEmail: 'x@y.com',
      isBookingTarget: true,
    });
    const connection = makeConnection({ isBookingTarget: false, targetCalendarId: 'cal-1' });
    render(
      <CalendarTargetCalendarPanel
        connection={connection}
        provider="google"
        pending={false}
        bookingTarget={target}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: 'Where bookings go' })).toHaveAccessibleDescription(
      "Bookings go to one account at a time — right now that's your Microsoft Outlook account (x@y.com). The calendar you pick here takes over if that account is disconnected."
    );
  });

  it('STANDBY branch (3b), target email unknown: drops the parenthetical', () => {
    const target = makeConnection({
      provider: 'microsoft',
      providerEmail: null,
      isBookingTarget: true,
    });
    const connection = makeConnection({ isBookingTarget: false, targetCalendarId: 'cal-1' });
    render(
      <CalendarTargetCalendarPanel
        connection={connection}
        provider="google"
        pending={false}
        bookingTarget={target}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: 'Where bookings go' })).toHaveAccessibleDescription(
      "Bookings go to one account at a time — right now that's your Microsoft Outlook account. The calendar you pick here takes over if that account is disconnected."
    );
  });

  // An older ACTIVE card with NO calendar picked yet becomes the target the
  // MOMENT a calendar is picked (it out-ages the current target) — picking doesn't wait for a
  // disconnect, so the takeover sentence would be false here. Only the first sentence renders.
  it('STANDBY branch (3a, no calendar picked here yet): names the target and stops — no false takeover claim', () => {
    const target = makeConnection({
      provider: 'microsoft',
      providerEmail: 'x@y.com',
      isBookingTarget: true,
    });
    const connection = makeConnection({ isBookingTarget: false, targetCalendarId: null });
    render(
      <CalendarTargetCalendarPanel
        connection={connection}
        provider="google"
        pending={false}
        bookingTarget={target}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: 'Where bookings go' })).toHaveAccessibleDescription(
      "Bookings go to one account at a time — right now that's your Microsoft Outlook account (x@y.com)."
    );
  });

  it('NO-TARGET branch: no writable connection anywhere gives the ICS copy', () => {
    const connection = makeConnection({ isBookingTarget: false, targetCalendarId: null });
    render(
      <CalendarTargetCalendarPanel
        connection={connection}
        provider="google"
        pending={false}
        bookingTarget={undefined}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: 'Where bookings go' })).toHaveAccessibleDescription(
      "Choose a calendar for your bookings. Until you do, we'll email you a calendar invite for each one."
    );
  });

  it('disabled wins over bookingTarget — a reconnecting card makes no routing claim even when it is the flagged target', () => {
    const connection = makeConnection({ isBookingTarget: true });
    render(
      <CalendarTargetCalendarPanel
        connection={connection}
        provider="google"
        pending={false}
        disabled
        bookingTarget={connection}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: 'Where bookings go' })).toHaveAccessibleDescription(
      'You can choose where bookings go once this account is reconnected.'
    );
  });

  // Two accounts of the SAME provider render two panels on one page: a provider-scoped id
  // alone would collide, and the second label would point at the first trigger.
  it('gives two panels for the same provider distinct ids, each label bound to its own trigger', () => {
    render(
      <>
        <CalendarTargetCalendarPanel
          connection={makeConnection()}
          provider="google"
          pending={false}
          bookingTarget={undefined}
          onChange={vi.fn()}
        />
        <CalendarTargetCalendarPanel
          connection={makeConnection({ providerEmail: 'dana.work@example.com' })}
          provider="google"
          pending
          bookingTarget={undefined}
          onChange={vi.fn()}
        />
      </>
    );
    const [first, second] = screen.getAllByRole('combobox', { name: 'Where bookings go' });
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.id).not.toBe(second?.id);
    // The label → trigger binding is per panel: the pending one is the second.
    expect(first).not.toBeDisabled();
    expect(second).toBeDisabled();
  });

  it('scopes the trigger id to microsoft for a microsoft connection', () => {
    render(
      <CalendarTargetCalendarPanel
        connection={makeConnection({ provider: 'microsoft' })}
        provider="microsoft"
        pending={false}
        bookingTarget={undefined}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: 'Where bookings go' }).id).toMatch(
      /^target-calendar-microsoft-/
    );
  });

  it('shows no stale-target warning when targetCalendarId matches a live sub-calendar', () => {
    render(
      <CalendarTargetCalendarPanel
        connection={makeConnection()}
        provider="google"
        pending={false}
        bookingTarget={undefined}
        onChange={vi.fn()}
      />
    );
    expect(screen.queryByText(/no longer on this account/)).not.toBeInTheDocument();
  });

  it('shows the stale-target warning when targetCalendarId points at a removed calendar (edge 10)', () => {
    render(
      <CalendarTargetCalendarPanel
        connection={makeConnection({ targetCalendarId: 'cal-gone' })}
        provider="google"
        pending={false}
        bookingTarget={undefined}
        onChange={vi.fn()}
      />
    );
    expect(
      screen.getByText('The calendar chosen here is no longer on this account — pick another.')
    ).toBeInTheDocument();
  });

  it('shows no stale-target warning when targetCalendarId is null (edge 9 — first provision found no primary)', () => {
    render(
      <CalendarTargetCalendarPanel
        connection={makeConnection({ targetCalendarId: null })}
        provider="google"
        pending={false}
        bookingTarget={undefined}
        onChange={vi.fn()}
      />
    );
    expect(screen.queryByText(/no longer on this account/)).not.toBeInTheDocument();
  });

  it('shows the placeholder rather than a stale target', () => {
    render(
      <CalendarTargetCalendarPanel
        connection={makeConnection({ targetCalendarId: 'cal-gone' })}
        provider="google"
        pending={false}
        bookingTarget={undefined}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: 'Where bookings go' })).toHaveTextContent(
      'Choose a calendar'
    );
  });

  it('keeps a long calendar name whole: truncatable in the trigger, in full on its title', () => {
    render(
      <CalendarTargetCalendarPanel
        connection={makeConnection({
          subCalendars: [makeSubCalendar({ name: 'charles.akintunde@gmail.com' })],
        })}
        provider="google"
        pending={false}
        bookingTarget={undefined}
        onChange={vi.fn()}
      />
    );
    const trigger = screen.getByRole('combobox', { name: 'Where bookings go' });
    expect(trigger).toHaveAttribute('title', 'charles.akintunde@gmail.com (Primary)');
    const value = screen.getByText('charles.akintunde@gmail.com (Primary)');
    expect(trigger).toContainElement(value);
    expect(value.className.split(' ')).toEqual(expect.arrayContaining(['block', 'truncate']));
    // Sized to its content from `sm` up, never a fixed width that clips an email.
    expect(trigger.className.split(' ')).toEqual(
      expect.arrayContaining(['sm:w-auto', 'sm:min-w-[240px]', 'min-w-0', 'max-w-full'])
    );
    expect(trigger.className).not.toContain('sm:w-56');
  });

  it('names a non-primary calendar without the Primary suffix, and titles no placeholder', () => {
    const { rerender } = render(
      <CalendarTargetCalendarPanel
        connection={makeConnection({
          targetCalendarId: 'cal-2',
          subCalendars: [
            makeSubCalendar(),
            makeSubCalendar({ id: 'cal-2', name: 'Team', primary: false }),
          ],
        })}
        provider="google"
        pending={false}
        bookingTarget={undefined}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: 'Where bookings go' })).toHaveAttribute(
      'title',
      'Team'
    );

    rerender(
      <CalendarTargetCalendarPanel
        connection={makeConnection({ targetCalendarId: null })}
        provider="google"
        pending={false}
        bookingTarget={undefined}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: 'Where bookings go' })).not.toHaveAttribute(
      'title'
    );
  });

  it('renders its label with the shared eyebrow styling', () => {
    render(
      <CalendarTargetCalendarPanel
        connection={makeConnection()}
        provider="google"
        pending={false}
        bookingTarget={undefined}
        onChange={vi.fn()}
      />
    );
    const label = screen.getByText('Where bookings go');
    expect(label.tagName).toBe('LABEL');
    expect(label.className.split(' ')).toEqual(
      expect.arrayContaining(['uppercase', 'text-[11px]', 'block'])
    );
  });

  it('disables the trigger when the panel itself is inert', () => {
    render(
      <CalendarTargetCalendarPanel
        connection={makeConnection()}
        provider="google"
        pending={false}
        disabled
        bookingTarget={undefined}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: 'Where bookings go' })).toBeDisabled();
  });

  it('disables the trigger while pending', () => {
    render(
      <CalendarTargetCalendarPanel
        connection={makeConnection()}
        provider="google"
        pending
        bookingTarget={undefined}
        onChange={vi.fn()}
      />
    );
    expect(screen.getByRole('combobox', { name: 'Where bookings go' })).toBeDisabled();
  });
});
