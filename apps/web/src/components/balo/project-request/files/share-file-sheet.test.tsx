import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from '@/test/axe';
import { CONVERSATION_FILE_ACCEPT } from '@/lib/storage/conversation-file-constraints';
import { ShareFileSheet, firstNameOf, shareButtonLabel } from './share-file-sheet';
import type {
  ShareFileMode,
  ShareFileTrack,
  ShareRecipients,
  ShareUploadState,
} from './share-file-types';

const REL_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_REL_ID = 'b0000000-0000-4000-8000-000000000003';

const TRACKS: ShareFileTrack[] = [
  { relationshipId: REL_ID, trackName: 'Wei Zhang' },
  { relationshipId: OTHER_REL_ID, trackName: 'Priya Raman' },
];
const CLIENT: ShareRecipients = { side: 'client', liveTracks: TRACKS };
const EXPERT: ShareRecipients = { side: 'expert', clientPartyName: 'Acme Corp' };

const THREAD: ShareFileMode = {
  kind: 'thread',
  threadRelationshipId: REL_ID,
  options: 'thread',
};
const UPLOADED: ShareUploadState = {
  fileName: 'nda.pdf',
  sizeBytes: 2048,
  progress: 100,
  status: 'uploaded',
};

interface SetupOptions {
  mode?: ShareFileMode;
  recipients?: ShareRecipients;
  upload?: ShareUploadState | null;
  pending?: boolean;
  confirming?: boolean;
  error?: string | null;
  initialNote?: string;
}

function setup(options: SetupOptions = {}): {
  onSubmit: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
  onPickFile: ReturnType<typeof vi.fn>;
  onRetryUpload: ReturnType<typeof vi.fn>;
} {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const onPickFile = vi.fn();
  const onRetryUpload = vi.fn();
  render(
    <ShareFileSheet
      open
      mode={options.mode ?? THREAD}
      recipients={options.recipients ?? CLIENT}
      upload={options.upload === undefined ? UPLOADED : options.upload}
      pending={options.pending ?? false}
      confirming={options.confirming ?? false}
      error={options.error ?? null}
      initialNote={options.initialNote}
      onPickFile={onPickFile}
      onRetryUpload={onRetryUpload}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
  return { onSubmit, onCancel, onPickFile, onRetryUpload };
}

const shareButton = (): HTMLElement => screen.getByRole('button', { name: /^(Share|Sharing)/ });

describe('shareButtonLabel', () => {
  it('names the client party for the expert side', () => {
    expect(shareButtonLabel({ type: 'client_party' }, 'Acme Corp')).toBe('Share with Acme Corp');
  });

  it('names everyone, one expert, several experts, and nobody', () => {
    expect(shareButtonLabel({ type: 'all' }, '')).toBe('Share with all interested experts');
    expect(shareButtonLabel({ type: 'tracks', firstNames: ['Wei'] }, '')).toBe('Share with Wei');
    expect(shareButtonLabel({ type: 'tracks', firstNames: ['Wei', 'Priya'] }, '')).toBe(
      'Share with 2 experts'
    );
    expect(shareButtonLabel({ type: 'tracks', firstNames: [] }, '')).toBe('Share');
  });

  it('takes the first word of a track name as the first name', () => {
    expect(firstNameOf('Wei Zhang')).toBe('Wei');
    expect(firstNameOf('  Priya  ')).toBe('Priya');
  });
});

describe('ShareFileSheet — thread mode, client on a matched request', () => {
  it('leads with "{name} only", preselected, ahead of the two broad options', () => {
    setup();
    const group = screen.getByRole('radiogroup', { name: 'Who can see it' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual([
      'Wei onlyJust this conversation.',
      'All interested experts · 2Experts who express interest later will also see this file.',
      'Only specific expertsFor sensitive documents — an NDA-gated contract, for example.',
    ]);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(radios[1]).toHaveAttribute('aria-checked', 'false');
    expect(radios[2]).toHaveAttribute('aria-checked', 'false');
  });

  it('shares to exactly that one track by default, naming them on the button', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ initialNote: 'Here is the NDA' });
    expect(shareButton()).toHaveTextContent('Share with Wei');
    await user.click(shareButton());
    expect(onSubmit).toHaveBeenCalledWith({
      share: { mode: 'grants', relationshipIds: [REL_ID] },
      audienceChoice: 'this_thread',
      note: 'Here is the NDA',
    });
  });

  it('shows the dialog title as the only header text', () => {
    setup();
    expect(screen.getByRole('heading', { name: 'Share a file' })).toBeInTheDocument();
    expect(screen.queryByText('Choose who can see it.')).not.toBeInTheDocument();
  });

  it('shares with everyone interested when that option is chosen', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.click(screen.getByRole('radio', { name: /All interested experts/ }));
    expect(shareButton()).toHaveTextContent('Share with all interested experts');
    expect(
      screen.getByText("Your note goes with the file to everyone it's shared with.")
    ).toBeInTheDocument();
    await user.click(shareButton());
    expect(onSubmit).toHaveBeenCalledWith({
      share: { mode: 'all_live_tracks' },
      audienceChoice: 'all_live_tracks',
      note: '',
    });
  });

  it('expands the checklist inside the specific-experts card, marking this conversation', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('radio', { name: /Only specific experts/ }));
    const checklist = screen.getByRole('group', { name: 'Experts who can see it' });
    expect(within(checklist).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(checklist).getByText('this conversation')).toBeInTheDocument();
    expect(within(checklist).getByRole('checkbox', { name: /Wei Zhang/ })).toBeChecked();
    expect(within(checklist).getByRole('checkbox', { name: /Priya Raman/ })).not.toBeChecked();
  });

  /** ⚠ AC8: no control nested in a button, and 44px rows on mobile. */
  it('keeps the checklist beside the radio button, never inside it, with 44px rows', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('radio', { name: /Only specific experts/ }));
    expect(document.body.querySelector('button input, button button')).toBeNull();
    const rows = screen
      .getByRole('group', { name: 'Experts who can see it' })
      .querySelectorAll('label');
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.className).toContain('min-h-11');
  });

  it('asks for at least one expert inline instead of disabling the button', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.click(screen.getByRole('radio', { name: /Only specific experts/ }));
    await user.click(screen.getByRole('checkbox', { name: /Wei Zhang/ }));
    expect(shareButton()).not.toBeDisabled();
    expect(shareButton()).toHaveTextContent('Share');
    await user.click(shareButton());
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one expert.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ties the pick-one error to the checklist for assistive tech', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('radio', { name: /Only specific experts/ }));
    const group = screen.getByRole('group', { name: 'Experts who can see it' });
    expect(group).not.toHaveAttribute('aria-invalid');
    await user.click(screen.getByRole('checkbox', { name: /Wei Zhang/ }));
    await user.click(shareButton());
    const alert = screen.getByRole('alert');
    expect(group).toHaveAttribute('aria-invalid', 'true');
    expect(group).toHaveAttribute('aria-describedby', alert.id);
  });

  it('moves between the audience options with the arrow keys, one tab stop at a time', async () => {
    const user = userEvent.setup();
    setup();
    const [only, all, some] = screen.getAllByRole('radio');
    expect(only).toHaveAttribute('tabindex', '0');
    expect(all).toHaveAttribute('tabindex', '-1');
    only?.focus();
    await user.keyboard('{ArrowDown}');
    expect(all).toHaveAttribute('aria-checked', 'true');
    expect(all).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(some).toHaveAttribute('aria-checked', 'true');
    expect(some).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(only).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowUp}');
    expect(some).toHaveAttribute('aria-checked', 'true');
    expect(some).toHaveFocus();
  });

  it('never titles the thread option "This only" when the thread has no live track', () => {
    setup({ mode: { ...THREAD, threadRelationshipId: 'gone' } });
    expect(screen.getByRole('radio', { name: /Share with this expert/ })).toBeInTheDocument();
    expect(screen.queryByText(/This (expert )?only/)).not.toBeInTheDocument();
  });

  it('restricts the file picker to the allowed types and clears it after a pick', async () => {
    const user = userEvent.setup();
    const { onPickFile } = setup({ mode: { kind: 'all_files' }, upload: null });
    const input = screen.getByLabelText('File') as HTMLInputElement;
    expect(input).toHaveAttribute('accept', CONVERSATION_FILE_ACCEPT);
    const pdf = new File(['x'], 'nda.pdf', { type: 'application/pdf' });
    await user.upload(input, pdf);
    expect(onPickFile).toHaveBeenCalledWith(pdf);
    expect(input.value).toBe('');
  });

  it('is axe-clean in the thread and the all-files modes', async () => {
    const first = render(
      <ShareFileSheet
        open
        mode={THREAD}
        recipients={CLIENT}
        upload={UPLOADED}
        pending={false}
        confirming={false}
        error={null}
        onPickFile={vi.fn()}
        onRetryUpload={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(await axe(document.body)).toHaveNoViolations();
    first.unmount();
    render(
      <ShareFileSheet
        open
        mode={{ kind: 'all_files' }}
        recipients={CLIENT}
        upload={null}
        pending={false}
        confirming={false}
        error="Pick at least one expert."
        onPickFile={vi.fn()}
        onRetryUpload={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('clears the inline error once the sharer picks someone', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('radio', { name: /Only specific experts/ }));
    await user.click(screen.getByRole('checkbox', { name: /Wei Zhang/ }));
    await user.click(shareButton());
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Priya Raman/ }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('warns that the file will not appear here when this expert is left out', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup();
    await user.click(screen.getByRole('radio', { name: /Only specific experts/ }));
    await user.click(screen.getByRole('checkbox', { name: /Wei Zhang/ }));
    await user.click(screen.getByRole('checkbox', { name: /Priya Raman/ }));
    expect(
      screen.getByText("This file won't appear in this conversation. Only Priya will see it.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("This file won't appear in this conversation. Only Priya will see it.")
    ).toHaveClass('text-warning-strong');
    expect(shareButton()).toHaveTextContent('Share with Priya');
    await user.click(shareButton());
    expect(onSubmit).toHaveBeenCalledWith({
      share: { mode: 'grants', relationshipIds: [OTHER_REL_ID] },
      audienceChoice: 'specific',
      note: '',
    });
  });

  it('does not warn while this conversation is still in the audience', () => {
    setup();
    expect(screen.queryByText(/won't appear in this conversation/)).not.toBeInTheDocument();
  });
});

describe('ShareFileSheet — one recipient, no options', () => {
  it('offers no audience options for a direct request, and names the one expert', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ mode: { ...THREAD, options: 'none' } });
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByText('Who can see it')).not.toBeInTheDocument();
    expect(shareButton()).toHaveTextContent('Share with Wei');
    await user.click(shareButton());
    expect(onSubmit).toHaveBeenCalledWith({
      share: { mode: 'grants', relationshipIds: [REL_ID] },
      audienceChoice: 'this_thread',
      note: '',
    });
  });

  it('offers no options on the expert side, and names the client party', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ recipients: EXPERT, mode: { ...THREAD, options: 'none' } });
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(shareButton()).toHaveTextContent('Share with Acme Corp');
    await user.click(shareButton());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ audienceChoice: 'this_thread' })
    );
  });
});

describe('ShareFileSheet — upload and sharing states', () => {
  it('shows the upload’s progress in the file tile', () => {
    setup({ upload: { ...UPLOADED, status: 'uploading', progress: 40 } });
    expect(screen.getByRole('progressbar', { name: 'Uploading nda.pdf' })).toHaveAttribute(
      'aria-valuenow',
      '40'
    );
  });

  it('shows the size once the upload has landed', () => {
    setup();
    expect(screen.getByText('2 KB')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  it('reads "Sharing… n%" with aria-busy once Share is pressed mid-upload, and ignores further presses', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({
      upload: { ...UPLOADED, status: 'uploading', progress: 40 },
      pending: true,
    });
    expect(shareButton()).toHaveTextContent('Sharing… 40%');
    expect(shareButton()).toHaveAttribute('aria-busy', 'true');
    await user.click(shareButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses Cancel only while the confirm call is in flight', async () => {
    const user = userEvent.setup();
    const first = setup({ pending: true, confirming: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(first.onCancel).not.toHaveBeenCalled();
  });

  it('cancels through the Cancel button', async () => {
    const user = userEvent.setup();
    const { onCancel } = setup({ pending: true });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('shows a failed upload inline with a way to try again', async () => {
    const user = userEvent.setup();
    const { onRetryUpload } = setup({
      upload: { ...UPLOADED, status: 'failed', progress: 30 },
      error: 'Could not upload your file. Please try again.',
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not upload your file');
    await user.click(screen.getByRole('button', { name: 'Try the upload again' }));
    expect(onRetryUpload).toHaveBeenCalledTimes(1);
  });

  it('carries the composer draft in as the note and sends edits to it', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ initialNote: 'Draft' });
    const note = screen.getByRole('textbox', { name: 'Note (optional)' });
    expect(note).toHaveValue('Draft');
    expect(note).toHaveAttribute('placeholder', 'Add a note to go with the file');
    await user.type(note, ' more');
    await user.click(shareButton());
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ note: 'Draft more' }));
  });
});

describe('ShareFileSheet — All files mode', () => {
  const ALL_FILES: ShareFileMode = { kind: 'all_files' };

  it('preselects all interested experts and offers the file picker', () => {
    setup({ mode: ALL_FILES, upload: null });
    expect(screen.getByLabelText('File')).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByText(/ only$/)).not.toBeInTheDocument();
  });

  it('asks for a file inline when Share is pressed with none chosen', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ mode: ALL_FILES, upload: null });
    await user.click(shareButton());
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a file to share.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('hands a picked file to the pipeline', async () => {
    const user = userEvent.setup();
    const { onPickFile } = setup({ mode: ALL_FILES, upload: null });
    const file = new File(['x'], 'nda.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('File'), file);
    expect(onPickFile).toHaveBeenCalledWith(file);
  });

  it('shares to every live track once a file is in', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ mode: ALL_FILES });
    expect(shareButton()).toHaveTextContent('Share with all interested experts');
    await user.click(shareButton());
    expect(onSubmit).toHaveBeenCalledWith({
      share: { mode: 'all_live_tracks' },
      audienceChoice: 'all_live_tracks',
      note: '',
    });
  });

  it('tells the client nobody has expressed interest yet when no track is live', async () => {
    const user = userEvent.setup();
    setup({ mode: ALL_FILES, recipients: { side: 'client', liveTracks: [] } });
    await user.click(screen.getByRole('radio', { name: /Only specific experts/ }));
    expect(screen.getByText('Experts who express interest will show up here.')).toBeInTheDocument();
  });

  it('picks specific experts from the checklist with none preselected', async () => {
    const user = userEvent.setup();
    const { onSubmit } = setup({ mode: ALL_FILES });
    await user.click(screen.getByRole('radio', { name: /Only specific experts/ }));
    expect(screen.queryByText('this conversation')).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Priya Raman/ }));
    await user.click(shareButton());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        share: { mode: 'grants', relationshipIds: [OTHER_REL_ID] },
        audienceChoice: 'specific',
      })
    );
  });
});
