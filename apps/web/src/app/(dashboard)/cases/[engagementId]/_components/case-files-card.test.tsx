import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import type { CaseFileRowView } from '@/lib/cases/case-view-types';

/**
 * BAL-421 §D4 — the merged files card.
 *
 * ⚠⚠ THE EMPTY STATE IS LENS-OF-LIFECYCLE, AND BOTH ARMS ARE TESTED. balo-ui's rule is that an
 * ACTIONABLE empty section keeps INVITATION copy rather than absence copy — but on a CLOSED
 * case the composer is read-only, so the invitation names an action this very surface has
 * already refused. That is CLAUDE.md's own stated exception, and the assertions below pin BOTH
 * directions so neither half can be "simplified" back into one string.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const mockDownload = vi.fn();
vi.mock('../_actions/get-case-file-download', () => ({
  getCaseFileDownloadAction: (...a: unknown[]) => mockDownload(...a),
}));

import { CaseFilesCard } from './case-files-card';

const MEETING_FILE: CaseFileRowView = {
  origin: 'meeting',
  id: 'mf-1',
  meetingId: 'm-1',
  fileName: 'intake-flow.pdf',
  contentType: 'application/pdf',
  sizeBytes: 12_800,
  createdAtIso: '2026-07-01T10:00:00Z',
  uploaderLabel: 'Amara',
  sourceLabel: 'Consultation 3',
};

const CONVERSATION_FILE: CaseFileRowView = {
  origin: 'conversation',
  id: 'cf-1',
  meetingId: null,
  fileName: 'notes.txt',
  contentType: 'text/plain',
  sizeBytes: 400,
  createdAtIso: '2026-07-02T10:00:00Z',
  uploaderLabel: 'You',
  sourceLabel: 'Conversation',
};

function renderCard(over: Partial<React.ComponentProps<typeof CaseFilesCard>> = {}) {
  return render(
    <CaseFilesCard
      engagementId={ENGAGEMENT_ID}
      files={[]}
      truncated={false}
      lens="client"
      isOpen
      counterpartyFirstName="Amara"
      {...over}
    />
  );
}

const INVITATION = /Share a file with Amara in the conversation/i;
const RETROSPECTIVE = 'No files were shared on this case.';

beforeEach(() => {
  vi.clearAllMocks();
  mockDownload.mockResolvedValue({ success: true, url: 'https://r2.example/signed' });
});

describe('CaseFilesCard — the empty state follows the case lifecycle', () => {
  it('INVITES while the case is OPEN — the composer is right there, so the section acts', () => {
    renderCard({ isOpen: true });
    expect(screen.getByText(INVITATION)).toBeInTheDocument();
    expect(screen.queryByText(RETROSPECTIVE)).not.toBeInTheDocument();
  });

  /**
   * ⚠ THE REGRESSION THIS EXISTS TO CATCH. A closed case renders "This case is closed, so the
   * conversation is read-only" one card away; inviting the viewer to "share a file … in the
   * conversation" in the same breath asks for something the surface has just refused.
   */
  it('turns RETROSPECTIVE on a CLOSED case — never inviting a refused action', () => {
    renderCard({ isOpen: false });
    expect(screen.getByText(RETROSPECTIVE)).toBeInTheDocument();
    expect(screen.queryByText(INVITATION)).not.toBeInTheDocument();
  });

  it('the closed copy promises no future — no "yet", no invitation verb', () => {
    const { container } = renderCard({ isOpen: false });
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).not.toContain('yet');
    expect(text).not.toContain('share a file');
  });

  it.each([['client'], ['expert']] as const)(
    'applies the same lifecycle rule on the %s lens',
    (lens) => {
      const { unmount } = renderCard({ lens, isOpen: true });
      expect(screen.getByText(INVITATION)).toBeInTheDocument();
      unmount();

      renderCard({ lens, isOpen: false });
      expect(screen.getByText(RETROSPECTIVE)).toBeInTheDocument();
    }
  );

  it('KEEPS the section on a closed case rather than hiding it', () => {
    // The files are still downloadable history; only the invitation is withdrawn.
    renderCard({ isOpen: false });
    expect(screen.getByText('Files')).toBeInTheDocument();
  });

  it('never shows the empty copy once there are files, open or closed', () => {
    const { unmount } = renderCard({ files: [MEETING_FILE], isOpen: false });
    expect(screen.queryByText(RETROSPECTIVE)).not.toBeInTheDocument();
    unmount();

    renderCard({ files: [MEETING_FILE], isOpen: true });
    expect(screen.queryByText(INVITATION)).not.toBeInTheDocument();
  });
});

describe('CaseFilesCard — the download branches on origin, and never exposes a key', () => {
  it('sends a MEETING file with its meetingId — BAL-423 needs it as a WHERE term', async () => {
    renderCard({ files: [MEETING_FILE] });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download intake-flow.pdf' }));
    expect(mockDownload).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      origin: 'meeting',
      fileId: 'mf-1',
      meetingId: 'm-1',
    });
  });

  it('sends a CONVERSATION file with no meetingId', async () => {
    renderCard({ files: [CONVERSATION_FILE] });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Download notes.txt' }));
    expect(mockDownload).toHaveBeenCalledWith({
      engagementId: ENGAGEMENT_ID,
      origin: 'conversation',
      fileId: 'cf-1',
    });
  });

  it('renders NO object key or signed url in the markup — the key is resolved server-side', () => {
    const { container } = renderCard({ files: [MEETING_FILE, CONVERSATION_FILE] });
    const html = container.innerHTML;
    expect(html).not.toContain('r2');
    expect(html).not.toContain('https://');
  });

  it('states truncation OUT LOUD — a partial list must not read as complete', () => {
    renderCard({ files: [MEETING_FILE], truncated: true });
    expect(screen.getByText('Showing the most recent files.')).toBeInTheDocument();
  });

  it('says nothing about truncation when the list is complete', () => {
    renderCard({ files: [MEETING_FILE], truncated: false });
    expect(screen.queryByText('Showing the most recent files.')).not.toBeInTheDocument();
  });

  it('keys rows by origin:id so the two tables cannot collide', () => {
    // `id` is unique only WITHIN its origin — a bare id could spin the wrong row.
    renderCard({
      files: [
        { ...MEETING_FILE, id: 'shared' },
        { ...CONVERSATION_FILE, id: 'shared' },
      ],
    });
    expect(screen.getByRole('button', { name: 'Download intake-flow.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download notes.txt' })).toBeInTheDocument();
  });
});
