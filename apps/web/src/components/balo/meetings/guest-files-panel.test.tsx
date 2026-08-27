import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { MeetingFileView } from '@/lib/meetings/meeting-file-view-types';
import type { MeetingGuestPanelRegistration } from '@/lib/meetings/meeting-panels';
import { GuestFilesPanel } from './guest-files-panel';

/**
 * BAL-445 — the GUEST Files panel. R9's "absence beats disablement", made executable: no
 * `<input type="file">`, no drop-zone role, no "Share a file" affordance anywhere.
 */

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { toast } from 'sonner';

function file(overrides: Partial<MeetingFileView> = {}): MeetingFileView {
  return {
    id: 'f1',
    meetingId: 'm1',
    fileName: 'spec.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    party: 'client',
    source: 'files_tab',
    uploadedByUserId: 'u1',
    createdAtIso: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function registration(
  overrides: Partial<MeetingGuestPanelRegistration['files']> = {}
): MeetingGuestPanelRegistration {
  return {
    audience: 'guest',
    files: {
      list: vi.fn().mockResolvedValue({ success: true, files: [] }),
      download: vi.fn().mockResolvedValue({ success: true, url: 'https://example.com/f' }),
      ...overrides,
    },
    chat: null,
  };
}

describe('GuestFilesPanel', () => {
  it('renders the list once loaded', async () => {
    const panels = registration({
      list: vi.fn().mockResolvedValue({ success: true, files: [file()] }),
    });
    render(<GuestFilesPanel panels={panels} onClose={vi.fn()} onAnnounce={vi.fn()} />);

    expect(await screen.findByText('spec.pdf')).toBeInTheDocument();
  });

  it('shows absence-framed empty copy — a guest cannot populate this list', async () => {
    const panels = registration();
    render(<GuestFilesPanel panels={panels} onClose={vi.fn()} onAnnounce={vi.fn()} />);

    expect(
      await screen.findByText('Nothing has been shared in this call yet.')
    ).toBeInTheDocument();
  });

  it('shows a retry-able error card on a failed load', async () => {
    const panels = registration({
      list: vi.fn().mockResolvedValue({ success: false, error: 'x' }),
    });
    render(<GuestFilesPanel panels={panels} onClose={vi.fn()} onAnnounce={vi.fn()} />);

    expect(await screen.findByText("We couldn't load the files")).toBeInTheDocument();
  });

  /**
   * ⚠⚠ F8/WARNING-1 (fix-round-1) — a genuine REJECTION (not a handled `{ success: false }`)
   * used to have no `.catch` anywhere on this path, leaving the panel on a PERMANENT skeleton.
   */
  it('⚠ a REJECTED list() (not a handled failure) still resolves to the error card, never a permanent skeleton', async () => {
    const panels = registration({
      list: vi.fn().mockRejectedValue(new Error('network blew up')),
    });
    render(<GuestFilesPanel panels={panels} onClose={vi.fn()} onAnnounce={vi.fn()} />);

    expect(await screen.findByText("We couldn't load the files")).toBeInTheDocument();
  });

  it('⚠⚠ ABSENCE, NOT DISABLEMENT — no upload affordance anywhere', async () => {
    const panels = registration({
      list: vi.fn().mockResolvedValue({ success: true, files: [file()] }),
    });
    const { container } = render(
      <GuestFilesPanel panels={panels} onClose={vi.fn()} onAnnounce={vi.fn()} />
    );
    await waitFor(() => expect(screen.getByText('spec.pdf')).toBeInTheDocument());

    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByText(/share a file/i)).toBeNull();
    expect(screen.queryAllByRole('button', { name: /share/i })).toHaveLength(0);
  });

  /**
   * ⚠⚠ CRITICAL / F4 (fix-round-1) — WAS: `if (!result.success) return;`, silently. The
   * spinner ran, the row reverted, and nothing told the guest anything had gone wrong. This
   * pins the member panel's `report`/announce pattern is mirrored here.
   */
  it('⚠⚠ announces a download failure — toast AND the live region, never silence', async () => {
    const user = userEvent.setup();
    const onAnnounce = vi.fn();
    const panels = registration({
      list: vi.fn().mockResolvedValue({ success: true, files: [file()] }),
      download: vi.fn().mockResolvedValue({
        success: false,
        error: 'This file is no longer available.',
      }),
    });
    render(<GuestFilesPanel panels={panels} onClose={vi.fn()} onAnnounce={onAnnounce} />);

    await user.click(await screen.findByRole('button', { name: 'Download spec.pdf' }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This file is no longer available.')
    );
    expect(onAnnounce).toHaveBeenCalledWith('This file is no longer available.');
  });

  it('has no accessibility violations', async () => {
    const panels = registration({
      list: vi.fn().mockResolvedValue({ success: true, files: [file()] }),
    });
    const { container } = render(
      <GuestFilesPanel panels={panels} onClose={vi.fn()} onAnnounce={vi.fn()} />
    );
    await waitFor(() => expect(screen.getByText('spec.pdf')).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });
});
