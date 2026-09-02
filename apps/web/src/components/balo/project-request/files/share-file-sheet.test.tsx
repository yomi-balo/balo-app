import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShareFileSheet, type ShareFileTrack } from './share-file-sheet';

const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_REL_ID = 'b0000000-0000-4000-8000-000000000003';

const TRACKS: ShareFileTrack[] = [
  { relationshipId: REL_ID, trackName: 'Wei Zhang' },
  { relationshipId: OTHER_REL_ID, trackName: 'Priya Raman' },
];

function setup(overrides: { liveTracks?: ShareFileTrack[]; submitting?: boolean } = {}): {
  onSubmit: ReturnType<typeof vi.fn>;
  onOpenChange: ReturnType<typeof vi.fn>;
} {
  const onSubmit = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <ShareFileSheet
      open
      onOpenChange={onOpenChange}
      liveTracks={overrides.liveTracks ?? TRACKS}
      submitting={overrides.submitting ?? false}
      onSubmit={onSubmit}
    />
  );
  return { onSubmit, onOpenChange };
}

const pdf = (name = 'nda.pdf'): File => new File(['x'], name, { type: 'application/pdf' });

const shareButton = (): HTMLElement => screen.getByRole('button', { name: /^Share/ });

describe('ShareFileSheet', () => {
  it('pluralises the live-expert count on the everyone-invited option', () => {
    setup({ liveTracks: [TRACKS[0]!] });
    expect(screen.getByText(/Everyone invited · 1 expert$/)).toBeInTheDocument();
  });

  it('uses the plural form for more than one live expert', () => {
    setup();
    expect(screen.getByText(/Everyone invited · 2 experts$/)).toBeInTheDocument();
  });

  /**
   * ⚠ SUBMIT IS GATED ON A FILE. Without this the client could "share" nothing and get a success
   * toast for a share that never happened.
   */
  it('keeps submit disabled until a file is chosen', async () => {
    const user = userEvent.setup();
    setup();
    expect(shareButton()).toBeDisabled();
    await user.upload(screen.getByLabelText('File'), pdf());
    expect(shareButton()).not.toBeDisabled();
  });

  it('disables submit while a share is already in flight', () => {
    setup({ submitting: true });
    // The submit control relabels to "Sharing…" in flight — so it is matched on the shared stem.
    expect(screen.getByRole('button', { name: 'Sharing…' })).toBeDisabled();
  });

  /**
   * ⚠ GRANTS MODE WITH ZERO PICKS IS NOT A SHARE. Submitting it would reach the repository,
   * which throws `audience=grants requires at least one grant target` — the picker must not let
   * the client get there.
   */
  it('re-disables submit when grants mode is selected with nothing picked', async () => {
    const user = userEvent.setup();
    setup();
    await user.upload(screen.getByLabelText('File'), pdf());
    expect(shareButton()).not.toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Only specific experts/ }));
    expect(shareButton()).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: 'Wei Zhang' }));
    expect(shareButton()).not.toBeDisabled();
  });

  it('submits the everyone-invited mode with no relationship ids', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.upload(screen.getByLabelText('File'), pdf());
    await user.click(shareButton());
    expect(onSubmit).toHaveBeenCalledWith('all_live_tracks', [], expect.any(File));
  });

  it('submits grants mode with exactly the picked tracks', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.upload(screen.getByLabelText('File'), pdf());
    await user.click(screen.getByRole('button', { name: /Only specific experts/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Priya Raman' }));
    await user.click(shareButton());
    expect(onSubmit).toHaveBeenCalledWith('grants', [OTHER_REL_ID], expect.any(File));
  });

  /** Un-ticking a checkbox must actually drop the pick, not merely toggle the visual. */
  it('drops a track from the picks when it is un-ticked', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.upload(screen.getByLabelText('File'), pdf());
    await user.click(screen.getByRole('button', { name: /Only specific experts/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Wei Zhang' }));
    await user.click(screen.getByRole('checkbox', { name: 'Priya Raman' }));
    await user.click(screen.getByRole('checkbox', { name: 'Wei Zhang' }));
    await user.click(shareButton());
    expect(onSubmit).toHaveBeenCalledWith('grants', [OTHER_REL_ID], expect.any(File));
  });

  /**
   * ⚠ SWITCHING BACK TO EVERYONE DISCARDS THE PICKS FROM THE PAYLOAD. `onSubmit` passes `[]` for
   * `all_live_tracks`; if it leaked the stale picks the server would receive a grants list on an
   * all-tracks share, which `assertShareShape` rejects.
   */
  it('sends no relationship ids after switching back from grants to everyone', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.upload(screen.getByLabelText('File'), pdf());
    await user.click(screen.getByRole('button', { name: /Only specific experts/ }));
    await user.click(screen.getByRole('checkbox', { name: 'Wei Zhang' }));
    await user.click(screen.getByRole('button', { name: /Everyone invited/ }));
    await user.click(shareButton());
    expect(onSubmit).toHaveBeenCalledWith('all_live_tracks', [], expect.any(File));
  });

  it('tells the client there is nobody to pick when no track is live', async () => {
    const user = userEvent.setup();
    setup({ liveTracks: [] });
    await user.click(screen.getByRole('button', { name: /Only specific experts/ }));
    expect(screen.getByText('No live experts to pick from.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('closes without submitting when cancelled', async () => {
    const user = userEvent.setup();
    const { onSubmit, onOpenChange } = setup();
    await user.upload(screen.getByLabelText('File'), pdf());
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  /**
   * ⚠ THE SHEET RESETS ON CLOSE. Without `reset()` the next open would still hold the previous
   * file and audience picks, so a client who cancelled a sensitive grants share and re-opened to
   * share something broadly would silently re-submit the ABANDONED file, or the abandoned
   * audience. Re-mounting is asserted through the reopened sheet's own state, not internals.
   */
  it('clears the chosen file and audience when closed and reopened', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            reopen
          </button>
          <ShareFileSheet
            open={open}
            onOpenChange={setOpen}
            liveTracks={TRACKS}
            submitting={false}
            onSubmit={onSubmit}
          />
        </>
      );
    }
    render(<Harness />);

    const dialogFile = screen.getAllByLabelText('File')[0]!;
    await user.upload(dialogFile, pdf('secret.pdf'));
    await user.click(screen.getAllByRole('button', { name: /Only specific experts/ })[0]!);
    await user.click(screen.getAllByRole('checkbox', { name: 'Wei Zhang' })[0]!);
    await user.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!);

    await user.click(screen.getByRole('button', { name: 'reopen' }));

    // Back to the default audience, with no file held over — so submit is gated again.
    expect(screen.getAllByRole('button', { name: /^Share/ })[0]!).toBeDisabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
