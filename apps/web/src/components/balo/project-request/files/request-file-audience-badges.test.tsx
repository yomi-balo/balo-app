import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RequestFileAudienceBadges } from './request-file-audience-badges';
import type { ClientRequestFileAudience } from '@/lib/request-files/request-file-audience-view';

const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_REL_ID = 'b0000000-0000-4000-8000-000000000003';

function renderBadges(
  audience: ClientRequestFileAudience,
  overrides: { revokingRelationshipId?: string | null } = {}
): { onRevoke: ReturnType<typeof vi.fn> } {
  const onRevoke = vi.fn();
  render(
    <RequestFileAudienceBadges
      audience={audience}
      onRevoke={onRevoke}
      revokingRelationshipId={overrides.revokingRelationshipId ?? null}
    />
  );
  return { onRevoke };
}

describe('RequestFileAudienceBadges', () => {
  describe('expert_own_track', () => {
    /**
     * ⚠ THE EXPERT-UPLOAD ARM AS THE CLIENT/ADMIN SEES IT. The copy must scope the file to the
     * expert's own conversation — "their conversation only" — because an expert upload is
     * hard-fixed to its own track and no sibling candidate may see it (ADR-1048 §1).
     */
    it('says the file is confined to that expert’s conversation', () => {
      renderBadges({ type: 'expert_own_track' });
      expect(screen.getByText('Their conversation only')).toBeInTheDocument();
    });

    it('offers no revoke control — an own-track upload has no grant to withdraw', () => {
      const { onRevoke } = renderBadges({ type: 'expert_own_track' });
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(onRevoke).not.toHaveBeenCalled();
    });
  });

  describe('all_live_tracks', () => {
    it('names the live-track count on the everyone-invited badge', () => {
      renderBadges({ type: 'all_live_tracks', liveTrackCount: 3, annotations: [] });
      expect(screen.getByText(/Everyone invited · 3 live/)).toBeInTheDocument();
    });

    /**
     * ⚠ THE MIRRORED DECLINE / NOT-SELECTED PAIR (Ruling 2, §12) — four combinations, four
     * distinct strings. `annotationText` is a flat lookup; these cases fail if any cell of that
     * lookup is swapped, or if `keptAccess` is inverted.
     *
     * Each pair is asserted BOTH ways round: the wording that must appear, and the wording from
     * the opposite cell that must NOT — so a lookup that returns a plausible-but-wrong sibling
     * string still fails.
     */
    it.each([
      {
        name: 'declined + kept access',
        reason: 'declined' as const,
        keptAccess: true,
        expected: 'Wei Zhang kept access · shared before declining',
        forbidden: 'Wei Zhang declined — not shared',
      },
      {
        name: 'declined + lost access',
        reason: 'declined' as const,
        keptAccess: false,
        expected: 'Wei Zhang declined — not shared',
        forbidden: 'Wei Zhang kept access · shared before declining',
      },
      {
        name: 'not selected + kept access',
        reason: 'not_selected' as const,
        keptAccess: true,
        expected: 'Wei Zhang kept access · shared before the project was awarded',
        forbidden: "Wei Zhang wasn't selected — not shared",
      },
      {
        name: 'not selected + lost access',
        reason: 'not_selected' as const,
        keptAccess: false,
        expected: "Wei Zhang wasn't selected — not shared",
        forbidden: 'Wei Zhang kept access · shared before the project was awarded',
      },
    ])(
      'annotates $name with its own wording and not its sibling’s',
      ({ reason, keptAccess, expected, forbidden }) => {
        renderBadges({
          type: 'all_live_tracks',
          liveTrackCount: 1,
          annotations: [{ relationshipId: REL_ID, trackName: 'Wei Zhang', reason, keptAccess }],
        });
        expect(screen.getByText(expected)).toBeInTheDocument();
        expect(screen.queryByText(forbidden)).not.toBeInTheDocument();
      }
    );

    it('renders one annotation per closed track', () => {
      renderBadges({
        type: 'all_live_tracks',
        liveTrackCount: 1,
        annotations: [
          {
            relationshipId: REL_ID,
            trackName: 'Wei Zhang',
            reason: 'declined',
            keptAccess: false,
          },
          {
            relationshipId: OTHER_REL_ID,
            trackName: 'Priya Raman',
            reason: 'not_selected',
            keptAccess: true,
          },
        ],
      });
      expect(screen.getByText('Wei Zhang declined — not shared')).toBeInTheDocument();
      expect(
        screen.getByText('Priya Raman kept access · shared before the project was awarded')
      ).toBeInTheDocument();
    });
  });

  describe('grants', () => {
    /**
     * ⚠ EMPTY GRANTS IS NOT "EVERYONE". A file whose every grant has been revoked must say so
     * explicitly — falling through to the all-live-tracks badge would tell the client the
     * opposite of the truth about who can read the file.
     */
    it('states that nobody has access when every grant is gone', () => {
      renderBadges({ type: 'grants', grants: [] });
      expect(screen.getByText('No experts have access')).toBeInTheDocument();
      expect(screen.queryByText(/Everyone invited/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('names each granted track and revokes the one whose control was pressed', async () => {
      const user = userEvent.setup();
      const { onRevoke } = renderBadges({
        type: 'grants',
        grants: [
          { relationshipId: REL_ID, trackName: 'Wei Zhang' },
          { relationshipId: OTHER_REL_ID, trackName: 'Priya Raman' },
        ],
      });
      expect(screen.getByText(/Wei Zhang only/)).toBeInTheDocument();
      expect(screen.getByText(/Priya Raman only/)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Remove access for Priya Raman' }));

      expect(onRevoke).toHaveBeenCalledTimes(1);
      expect(onRevoke).toHaveBeenCalledWith(OTHER_REL_ID, 'Priya Raman');
    });

    /** An in-flight revoke must not be double-submitted — the control disables itself. */
    it('disables only the grant currently being revoked', () => {
      renderBadges(
        {
          type: 'grants',
          grants: [
            { relationshipId: REL_ID, trackName: 'Wei Zhang' },
            { relationshipId: OTHER_REL_ID, trackName: 'Priya Raman' },
          ],
        },
        { revokingRelationshipId: REL_ID }
      );
      expect(screen.getByRole('button', { name: 'Remove access for Wei Zhang' })).toBeDisabled();
      expect(
        screen.getByRole('button', { name: 'Remove access for Priya Raman' })
      ).not.toBeDisabled();
    });
  });
});
