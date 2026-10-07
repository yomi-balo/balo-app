import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { GUEST_ACTION_COPY } from '@/lib/meetings/guests-copy';
import { MEETING_PANEL_EVENTS, track } from '@/lib/analytics';
import type { VouchActionResult } from '@/lib/meetings/meeting-panels';
import { VouchGuestDialog } from './vouch-guest-dialog';

const MEETING_PROPS = { meeting_id: 'meeting-1' };

function setup(
  overrides: {
    onVouch?: Mock<(email: string) => Promise<VouchActionResult>>;
    onOpenChange?: Mock<(open: boolean) => void>;
  } = {}
) {
  const onVouch =
    overrides.onVouch ??
    vi.fn<(email: string) => Promise<VouchActionResult>>().mockResolvedValue({ success: true });
  const onOpenChange = overrides.onOpenChange ?? vi.fn<(open: boolean) => void>();
  const report = vi.fn();
  const onVouched = vi.fn().mockResolvedValue(undefined);
  render(
    <VouchGuestDialog
      open
      onOpenChange={onOpenChange}
      guestName="Taylor Wu"
      onVouch={onVouch}
      report={report}
      onVouched={onVouched}
      meetingProps={MEETING_PROPS}
    />
  );
  return { onVouch, onOpenChange, report, onVouched };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('VouchGuestDialog', () => {
  it('names the person, states the consequence and labels the field', () => {
    setup();

    expect(screen.getByRole('dialog', { name: 'Vouch for Taylor Wu?' })).toBeInTheDocument();
    expect(screen.getByText(/time with the expert counts toward this consultation/)).toBeVisible();
    expect(screen.getByLabelText('Their work email')).toBeInTheDocument();
  });

  it('keeps Vouch disabled until an address is typed', async () => {
    const user = userEvent.setup();
    setup();

    expect(screen.getByRole('button', { name: 'Vouch' })).toBeDisabled();
    await user.type(screen.getByLabelText('Their work email'), 'a@b.example');
    expect(screen.getByRole('button', { name: 'Vouch' })).toBeEnabled();
  });

  it('submits the trimmed address, reports success, tracks, closes and refreshes', async () => {
    const user = userEvent.setup();
    const { onVouch, onOpenChange, report, onVouched } = setup();

    await user.type(screen.getByLabelText('Their work email'), '  dana@northwind.example ');
    await user.click(screen.getByRole('button', { name: 'Vouch' }));

    await waitFor(() => expect(onVouch).toHaveBeenCalledWith('dana@northwind.example'));
    await waitFor(() => expect(onVouched).toHaveBeenCalled());
    expect(report).toHaveBeenCalledWith('success', 'Taylor Wu is in as your colleague.');
    expect(track).toHaveBeenCalledWith(MEETING_PANEL_EVENTS.GUEST_VOUCHED, {
      ...MEETING_PROPS,
      outcome: 'ok',
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('reports a failure, tracks it, and stays open', async () => {
    const user = userEvent.setup();
    const onVouch = vi.fn().mockResolvedValue({
      success: false,
      error: "They're already on the list.",
      status: 409,
      code: 'guest_already_invited',
    });
    const { report, onOpenChange, onVouched } = setup({ onVouch });

    await user.type(screen.getByLabelText('Their work email'), 'dana@northwind.example');
    await user.click(screen.getByRole('button', { name: 'Vouch' }));

    await waitFor(() =>
      expect(report).toHaveBeenCalledWith('error', "They're already on the list.")
    );
    expect(track).toHaveBeenCalledWith(MEETING_PANEL_EVENTS.GUEST_VOUCHED, {
      ...MEETING_PROPS,
      outcome: 'failed',
      status: 409,
      code: 'guest_already_invited',
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onVouched).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Vouch' })).toBeEnabled();
    expect(await screen.findByRole('alert')).toHaveTextContent("They're already on the list.");
    const field = screen.getByLabelText('Their work email');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription("They're already on the list.");
  });

  it('focuses the email field on open and marks it required with a placeholder', () => {
    setup();

    const field = screen.getByLabelText('Their work email');
    expect(field).toHaveFocus();
    expect(field).toBeRequired();
    expect(field).toHaveAttribute('placeholder', 'name@company.com');
  });

  it('shows the request-failed copy and recovers when onVouch rejects', async () => {
    const user = userEvent.setup();
    const onVouch = vi
      .fn<(email: string) => Promise<VouchActionResult>>()
      .mockRejectedValue(new Error('boom'));
    const { report } = setup({ onVouch });

    await user.type(screen.getByLabelText('Their work email'), 'dana@northwind.example');
    await user.click(screen.getByRole('button', { name: 'Vouch' }));

    await waitFor(() =>
      expect(report).toHaveBeenCalledWith('error', GUEST_ACTION_COPY.request_failed)
    );
    expect(screen.getByRole('alert')).toHaveTextContent(GUEST_ACTION_COPY.request_failed);
    expect(screen.getByRole('button', { name: 'Vouch' })).toBeEnabled();
  });

  it('⚠ disables ONLY the confirm button while pending — Cancel stays usable', async () => {
    const user = userEvent.setup();
    const onVouch = vi
      .fn<(email: string) => Promise<VouchActionResult>>()
      .mockReturnValue(new Promise(() => {}));
    const { onOpenChange } = setup({ onVouch });

    await user.type(screen.getByLabelText('Their work email'), 'dana@northwind.example');
    await user.click(screen.getByRole('button', { name: 'Vouch' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Vouch' })).toBeDisabled());
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeEnabled();
    await user.click(cancel);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not submit twice while a request is in flight', async () => {
    const user = userEvent.setup();
    const onVouch = vi
      .fn<(email: string) => Promise<VouchActionResult>>()
      .mockReturnValue(new Promise(() => {}));
    setup({ onVouch });

    await user.type(screen.getByLabelText('Their work email'), 'dana@northwind.example{Enter}');
    await user.keyboard('{Enter}');

    expect(onVouch).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations', async () => {
    setup();

    expect(await axe(document.body)).toHaveNoViolations();
  });
});
