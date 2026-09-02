import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequestFileRow } from './request-file-row';
import type {
  ClientRequestFileView,
  ExpertRequestFileView,
  AdminRequestFileView,
} from '@/lib/request-files/request-file-audience-view';

const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const FILE_ID = 'd0000000-0000-4000-8000-000000000007';
const CLIENT_PARTY = 'Acme Corp';

const EXPERT_OWN: ExpertRequestFileView = {
  id: FILE_ID,
  fileName: 'Proposal-draft.pdf',
  contentType: 'application/pdf',
  sizeBytes: 512,
  source: 'you',
  uploadedByName: 'You',
  createdAtIso: '2026-08-02T00:00:00.000Z',
  sharedBeforeYouJoined: false,
  canDelete: true,
};

const CLIENT_FILE: ClientRequestFileView = {
  id: FILE_ID,
  fileName: 'Requirements.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2048,
  source: 'client',
  uploadedByName: 'Sarah Chen @ Acme Corp',
  createdAtIso: '2026-08-01T00:00:00.000Z',
  audience: { type: 'grants', grants: [{ relationshipId: REL_ID, trackName: 'Wei Zhang' }] },
  canDelete: true,
};

const ADMIN_FILE: AdminRequestFileView = {
  id: FILE_ID,
  fileName: 'Requirements.pdf',
  contentType: 'application/pdf',
  sizeBytes: 2048,
  side: 'client',
  audience: 'all_live_tracks',
  uploadedByName: 'Sarah Chen',
  createdAtIso: '2026-08-01T00:00:00.000Z',
  visibleTo: [{ relationshipId: REL_ID, trackName: 'Wei Zhang', via: 'all_live_tracks' }],
  deleted: false,
  deletedAtIso: null,
  deletedByName: null,
};

function renderExpert(
  file: ExpertRequestFileView,
  state: { downloadingId?: string | null; deletingId?: string | null } = {}
): { onDownload: ReturnType<typeof vi.fn>; onDelete: ReturnType<typeof vi.fn> } {
  const onDownload = vi.fn();
  const onDelete = vi.fn();
  render(
    <ul>
      <RequestFileRow
        lens="expert"
        file={file}
        clientPartyName={CLIENT_PARTY}
        onDownload={onDownload}
        onDelete={onDelete}
        downloadingId={state.downloadingId ?? null}
        deletingId={state.deletingId ?? null}
      />
    </ul>
  );
  return { onDownload, onDelete };
}

describe('RequestFileRow', () => {
  describe('expert lens', () => {
    /**
     * ⚠ THE ROW'S HANDLERS MUST CARRY THE ROW'S OWN FILE ID. Both are built as closures over
     * `file.id`; passing the wrong id would download or destroy a DIFFERENT file, which is
     * exactly the class of bug a shared row component invites.
     */
    it('downloads the file the row is for', async () => {
      const user = userEvent.setup();
      const { onDownload } = renderExpert(EXPERT_OWN);
      await user.click(screen.getByRole('button', { name: 'Download Proposal-draft.pdf' }));
      expect(onDownload).toHaveBeenCalledWith(FILE_ID);
    });

    it('deletes the file the row is for', async () => {
      const user = userEvent.setup();
      const { onDelete } = renderExpert(EXPERT_OWN);
      await user.click(screen.getByRole('button', { name: 'Remove Proposal-draft.pdf' }));
      expect(onDelete).toHaveBeenCalledWith(FILE_ID);
    });

    /**
     * ⚠ NO DELETE CONTROL WITHOUT THE RIGHT. `canDelete` is resolved server-side (Ruling 3); the
     * row must not render an affordance the server would refuse — a client-uploaded file as the
     * expert sees it is never the expert's to remove.
     */
    it('offers no remove control when the viewer may not delete the file', () => {
      renderExpert({ ...EXPERT_OWN, source: 'client', canDelete: false });
      expect(screen.getByRole('button', { name: /^Download/ })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
    });

    it('disables only the row whose download is in flight', () => {
      renderExpert(EXPERT_OWN, { downloadingId: FILE_ID });
      expect(screen.getByRole('button', { name: 'Download Proposal-draft.pdf' })).toBeDisabled();
    });

    it('disables the remove control while that row is being deleted', () => {
      renderExpert(EXPERT_OWN, { deletingId: FILE_ID });
      expect(screen.getByRole('button', { name: 'Remove Proposal-draft.pdf' })).toBeDisabled();
    });

    it('leaves the controls enabled while a DIFFERENT row is mutating', () => {
      renderExpert(EXPERT_OWN, { downloadingId: 'some-other-file', deletingId: 'some-other-file' });
      expect(
        screen.getByRole('button', { name: 'Download Proposal-draft.pdf' })
      ).not.toBeDisabled();
      expect(screen.getByRole('button', { name: 'Remove Proposal-draft.pdf' })).not.toBeDisabled();
    });

    /**
     * ⚠ THE PRE-JOIN BADGE. A file shared before this expert was invited is legitimately
     * readable by them, and saying so is what stops it looking like a leak.
     */
    it('marks a file shared before the expert joined', () => {
      renderExpert({ ...EXPERT_OWN, source: 'client', sharedBeforeYouJoined: true });
      expect(screen.getByText('Shared before you joined')).toBeInTheDocument();
    });

    it('does not mark a file the expert was always able to see', () => {
      renderExpert({ ...EXPERT_OWN, source: 'client', sharedBeforeYouJoined: false });
      expect(screen.queryByText('Shared before you joined')).not.toBeInTheDocument();
    });

    /** Concealment: the expert row has no audience vocabulary at all — keys AND values. */
    it('leaks no audience or audit wording on a client file', () => {
      const { container } = render(
        <ul>
          <RequestFileRow
            lens="expert"
            file={{ ...EXPERT_OWN, source: 'client', canDelete: false }}
            clientPartyName={CLIENT_PARTY}
            onDownload={vi.fn()}
            onDelete={vi.fn()}
            downloadingId={null}
            deletingId={null}
          />
        </ul>
      );
      const text = container.textContent ?? '';
      for (const forbidden of [
        'Everyone invited',
        'Their conversation only',
        'No experts have access',
        'Visible now to:',
        'audit record kept',
        'Wei Zhang',
        'audience:',
      ]) {
        expect(text).not.toContain(forbidden);
      }
    });
  });

  describe('client lens', () => {
    it('routes a revoke with the row’s file id alongside the grant’s track', async () => {
      const user = userEvent.setup();
      const onRevoke = vi.fn();
      render(
        <ul>
          <RequestFileRow
            lens="client"
            file={CLIENT_FILE}
            onDownload={vi.fn()}
            onDelete={vi.fn()}
            onRevoke={onRevoke}
            downloadingId={null}
            deletingId={null}
            revokingRelationshipId={null}
          />
        </ul>
      );
      await user.click(screen.getByRole('button', { name: 'Remove access for Wei Zhang' }));
      expect(onRevoke).toHaveBeenCalledWith(FILE_ID, REL_ID, 'Wei Zhang');
    });

    /** The spreadsheet glyph is chosen by content type — csv included, not just the office mime. */
    it.each([
      ['text/csv', true],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', true],
      ['application/pdf', false],
    ])('picks the spreadsheet glyph for %s: %s', (contentType, isSpreadsheet) => {
      const { container } = render(
        <ul>
          <RequestFileRow
            lens="client"
            file={{ ...CLIENT_FILE, contentType }}
            onDownload={vi.fn()}
            onDelete={vi.fn()}
            onRevoke={vi.fn()}
            downloadingId={null}
            deletingId={null}
            revokingRelationshipId={null}
          />
        </ul>
      );
      const glyph = container.querySelector('svg.lucide');
      expect(glyph?.classList.contains('lucide-file-spreadsheet')).toBe(isSpreadsheet);
    });
  });

  describe('admin lens', () => {
    it('renders no mutation controls at all — the lens is read-only by construction', () => {
      render(
        <ul>
          <RequestFileRow lens="admin" file={ADMIN_FILE} />
        </ul>
      );
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('names the audience for a client file and the own-track fact for an expert one', () => {
      const { rerender } = render(
        <ul>
          <RequestFileRow lens="admin" file={ADMIN_FILE} />
        </ul>
      );
      expect(screen.getByText(/audience: all_live_tracks/)).toBeInTheDocument();

      rerender(
        <ul>
          <RequestFileRow
            lens="admin"
            file={{ ...ADMIN_FILE, side: 'expert', audience: 'own_track' }}
          />
        </ul>
      );
      expect(screen.getByText(/expert upload, own track/)).toBeInTheDocument();
      expect(screen.queryByText(/audience: own_track/)).not.toBeInTheDocument();
    });

    it('says "no experts" rather than nothing when a file reaches nobody', () => {
      render(
        <ul>
          <RequestFileRow lens="admin" file={{ ...ADMIN_FILE, visibleTo: [] }} />
        </ul>
      );
      expect(screen.getByText('Visible now to:')).toBeInTheDocument();
      expect(screen.getByText('no experts')).toBeInTheDocument();
    });

    /** A tombstone is struck through so it cannot be mistaken for a live file in the audit list. */
    it('strikes through a removed file’s name', () => {
      render(
        <ul>
          <RequestFileRow lens="admin" file={{ ...ADMIN_FILE, deleted: true }} />
        </ul>
      );
      expect(screen.getByText('Requirements.pdf').className).toContain('line-through');
    });

    it('does not strike through a live file', () => {
      render(
        <ul>
          <RequestFileRow lens="admin" file={ADMIN_FILE} />
        </ul>
      );
      expect(screen.getByText('Requirements.pdf').className).not.toContain('line-through');
    });
  });
});
