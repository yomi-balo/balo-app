'use client';

import { useId, useState } from 'react';
import { Check, Loader2, Lock, Upload, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { formatBytes } from '@/components/balo/document-uploader/upload-file';
// ⚠ FROM THE CLIENT-SAFE CONSTRAINTS MODULE, not `@/lib/storage/request-file` — that one is
// `server-only`. `REQUEST_FILE_ACCEPT` is its verbatim re-export of this same constant.
import { CONVERSATION_FILE_ACCEPT as REQUEST_FILE_ACCEPT } from '@/lib/storage/conversation-file-constraints';
import { FileGlyph } from './file-glyph';
import type {
  ShareFileMode,
  ShareFileTrack,
  ShareRecipients,
  ShareSubmission,
  ShareUploadState,
} from './share-file-types';

/** Who a share reaches, as the primary button names it. */
export type ShareAudience =
  | { type: 'client_party' }
  | { type: 'all' }
  | { type: 'tracks'; firstNames: readonly string[] };

/** The first word of a track's display name — what the copy calls an expert. */
export function firstNameOf(trackName: string): string {
  const [first] = trackName.trim().split(/\s+/);
  return first === undefined || first === '' ? trackName : first;
}

/** The primary button names the audience, so the commit says exactly what it does. */
export function shareButtonLabel(audience: ShareAudience, clientPartyName: string): string {
  if (audience.type === 'client_party') return `Share with ${clientPartyName}`;
  if (audience.type === 'all') return 'Share with all interested experts';
  const [only] = audience.firstNames;
  if (only === undefined) return 'Share';
  if (audience.firstNames.length === 1) return `Share with ${only}`;
  return `Share with ${audience.firstNames.length} experts`;
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
  const [first] = names;
  if (first === undefined) return '';
  if (names.length === 1) return first;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

type Choice = 'this' | 'all' | 'some' | 'fixed';

function seedChoice(mode: ShareFileMode, showOptions: boolean): Choice {
  if (!showOptions) return 'fixed';
  return mode.kind === 'thread' ? 'this' : 'all';
}

const PICK_ONE_COPY = 'Pick at least one expert.';

/** Arrow key → direction along the radio list (down/right advance, up/left go back). */
const ARROW_STEPS: Readonly<Record<string, number>> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
};

interface BuiltSubmission {
  submission: Omit<ShareSubmission, 'note'> | null;
  error: string | null;
}

/** The share payload for the current choice, or the inline error that blocks it. */
function buildSelection(
  choice: Choice,
  picks: readonly string[],
  threadId: string | null,
  recipients: ShareRecipients
): BuiltSubmission {
  if (choice === 'all') {
    return {
      submission: { share: { mode: 'all_live_tracks' }, audienceChoice: 'all_live_tracks' },
      error: null,
    };
  }
  if (choice === 'some') {
    if (picks.length === 0) return { submission: null, error: PICK_ONE_COPY };
    return {
      submission: {
        share: { mode: 'grants', relationshipIds: [...picks] },
        audienceChoice: 'specific',
      },
      error: null,
    };
  }
  // 'this' and 'fixed' both mean "the one conversation this share started from"; an expert's
  // audience is decided by the server, so the grant list is only a placeholder there.
  if (recipients.side === 'expert' || threadId === null) {
    return {
      submission: { share: { mode: 'all_live_tracks' }, audienceChoice: 'this_thread' },
      error: null,
    };
  }
  return {
    submission: {
      share: { mode: 'grants', relationshipIds: [threadId] },
      audienceChoice: 'this_thread',
    },
    error: null,
  };
}

interface AudienceView {
  audience: ShareAudience;
  reachedIds: string[];
}

function trackIdsFor(
  choice: Choice,
  picks: readonly string[],
  threadId: string | null
): readonly string[] {
  if (choice === 'some') return picks;
  return threadId === null ? [] : [threadId];
}

function audienceFor(
  choice: Choice,
  picks: readonly string[],
  threadId: string | null,
  recipients: ShareRecipients
): AudienceView {
  if (recipients.side === 'expert') return { audience: { type: 'client_party' }, reachedIds: [] };
  const live = recipients.liveTracks;
  if (choice === 'all') {
    return { audience: { type: 'all' }, reachedIds: live.map((t) => t.relationshipId) };
  }
  const ids = trackIdsFor(choice, picks, threadId);
  const reached = live.filter((t) => ids.includes(t.relationshipId));
  return {
    audience: { type: 'tracks', firstNames: reached.map((t) => firstNameOf(t.trackName)) },
    reachedIds: reached.map((t) => t.relationshipId),
  };
}

interface OptionCardProps {
  value: Choice;
  selected: boolean;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  title: string;
  sub: string;
  onSelect: () => void;
  children?: React.ReactNode;
}

/**
 * One choice. The card is the container; the radio is its header row. A choice with follow-up
 * input (the expert checklist) expands INSIDE the same card, and its checkboxes sit BESIDE the
 * radio button, never inside it — no interactive content nested in a `<button>`.
 */
function OptionCard({
  value,
  selected,
  icon: Icon,
  title,
  sub,
  onSelect,
  children,
}: Readonly<OptionCardProps>): React.JSX.Element {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-[10px] border',
        selected ? 'border-primary bg-primary/5' : 'border-border bg-card'
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        data-choice={value}
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
        className="focus-visible:ring-ring flex min-h-11 w-full items-start gap-2.5 px-3 py-2.5 text-left focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
      >
        <Icon className="text-primary mt-0.5 h-4 w-4 shrink-0" aria-hidden={true} />
        <span>
          <span className="text-foreground block text-sm font-medium">{title}</span>
          <span className="text-muted-foreground mt-px block text-[12.5px]">{sub}</span>
        </span>
      </button>
      {selected && children}
    </div>
  );
}

interface ExpertChecklistProps {
  tracks: readonly ShareFileTrack[];
  picks: readonly string[];
  threadId: string | null;
  invalid: boolean;
  describedBy: string;
  onToggle: (relationshipId: string) => void;
}

function ExpertChecklist({
  tracks,
  picks,
  threadId,
  invalid,
  describedBy,
  onToggle,
}: Readonly<ExpertChecklistProps>): React.JSX.Element {
  const baseId = useId();
  return (
    // Indented to the title's left edge: 12px card padding + 16px icon + 10px gap.
    <div
      role="group"
      aria-label="Experts who can see it"
      aria-invalid={invalid || undefined}
      aria-describedby={invalid ? describedBy : undefined}
      className="flex flex-col pr-3 pb-2 pl-[38px]"
    >
      <span aria-hidden="true" className="bg-primary/30 mb-1 h-px" />
      {tracks.length === 0 && (
        <p className="text-muted-foreground py-1.5 text-xs">
          Experts who express interest will show up here.
        </p>
      )}
      {tracks.map((track) => {
        const id = `${baseId}-${track.relationshipId}`;
        return (
          <label
            key={track.relationshipId}
            htmlFor={id}
            className="text-foreground flex min-h-11 cursor-pointer items-center gap-2.5 text-sm sm:min-h-9"
          >
            <Checkbox
              id={id}
              checked={picks.includes(track.relationshipId)}
              onCheckedChange={() => onToggle(track.relationshipId)}
            />
            {track.trackName}
            {track.relationshipId === threadId && (
              <span className="text-muted-foreground text-xs">this conversation</span>
            )}
          </label>
        );
      })}
    </div>
  );
}

function UploadTile({ upload }: Readonly<{ upload: ShareUploadState }>): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 py-0.5">
      <FileGlyph contentType="" className="h-10 w-10 rounded-[10px]" />
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-[13.5px] font-medium">{upload.fileName}</p>
        {upload.status === 'uploading' ? (
          <div className="mt-1 flex items-center gap-2">
            <span
              role="progressbar"
              aria-label={`Uploading ${upload.fileName}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={upload.progress}
              className="bg-border h-1 flex-1 overflow-hidden rounded-full"
            >
              <span className="bg-primary block h-full" style={{ width: `${upload.progress}%` }} />
            </span>
            <span className="text-muted-foreground text-[11.5px] tabular-nums">
              {upload.progress}%
            </span>
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">{formatBytes(upload.sizeBytes)}</p>
        )}
      </div>
    </div>
  );
}

interface ShareFileSheetProps {
  open: boolean;
  mode: ShareFileMode;
  recipients: ShareRecipients;
  upload: ShareUploadState | null;
  /** Share was pressed and has not landed yet. */
  pending: boolean;
  /** The confirm call is in flight — Cancel is refused. */
  confirming: boolean;
  /** A failed upload or a refused share, shown inline. */
  error: string | null;
  /** The composer draft, carried in as the note. */
  initialNote?: string;
  /** `all_files` mode: a file was chosen in the dialog. */
  onPickFile?: (file: File) => void;
  onRetryUpload: () => void;
  onSubmit: (submission: ShareSubmission) => void;
  onCancel: () => void;
}

/**
 * The share dialog (BAL-431, reshaped by BAL-617), reused for both ways in.
 *
 *  · `thread` — opened by the composer paperclip or a drop on the conversation. The file is
 *    already picked and uploading. A client on a matched request gets three options with
 *    "{name} only" first and preselected; a direct request and the expert side get none — one
 *    recipient, nothing to choose.
 *  · `all_files` — "Share with several experts" in All files: a file picker, the two broad
 *    options, "All interested experts" preselected.
 *
 * Both carry a note and a primary button named by the audience. Pressing it mid-upload shows
 * progress and completes on its own; Cancel discards the upload.
 */
export function ShareFileSheet(props: Readonly<ShareFileSheetProps>): React.JSX.Element {
  const { open, confirming, onCancel } = props;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !confirming) onCancel();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className={cn(
          'max-h-[calc(100dvh-2rem)] gap-3 overflow-y-auto p-5 sm:max-w-[460px]',
          'max-sm:top-auto max-sm:bottom-0 max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none'
        )}
      >
        <ShareFileForm {...props} />
      </DialogContent>
    </Dialog>
  );
}

function ShareFileForm({
  mode,
  recipients,
  upload,
  pending,
  confirming,
  error,
  initialNote = '',
  onPickFile,
  onRetryUpload,
  onSubmit,
  onCancel,
}: Readonly<Omit<ShareFileSheetProps, 'open'>>): React.JSX.Element {
  const ids = useId();
  const threadId = mode.kind === 'thread' ? mode.threadRelationshipId : null;
  const showOptions =
    recipients.side === 'client' && (mode.kind === 'all_files' || mode.options === 'thread');
  const [choice, setChoice] = useState<Choice>(() => seedChoice(mode, showOptions));
  const [picks, setPicks] = useState<string[]>(() => (threadId === null ? [] : [threadId]));
  const [note, setNote] = useState(initialNote);
  const [validation, setValidation] = useState<string | null>(null);

  const liveTracks = recipients.side === 'client' ? recipients.liveTracks : [];
  const threadTrack = liveTracks.find((t) => t.relationshipId === threadId);
  const { audience, reachedIds } = audienceFor(choice, picks, threadId, recipients);
  const clientPartyName = recipients.side === 'expert' ? recipients.clientPartyName : '';

  function select(next: Choice): void {
    setChoice(next);
    setValidation(null);
  }

  function togglePick(relationshipId: string): void {
    setPicks((current) =>
      current.includes(relationshipId)
        ? current.filter((id) => id !== relationshipId)
        : [...current, relationshipId]
    );
    setValidation(null);
  }

  function handleShare(): void {
    if (pending) return;
    if (mode.kind === 'all_files' && upload === null) {
      setValidation('Choose a file to share.');
      return;
    }
    const built = buildSelection(choice, picks, threadId, recipients);
    if (built.submission === null) {
      setValidation(built.error);
      return;
    }
    setValidation(null);
    onSubmit({ ...built.submission, note });
  }

  const excludesThisThread =
    mode.kind === 'thread' &&
    showOptions &&
    threadId !== null &&
    !reachedIds.includes(threadId) &&
    reachedIds.length > 0;
  const excludedNames = liveTracks
    .filter((t) => reachedIds.includes(t.relationshipId))
    .map((t) => firstNameOf(t.trackName));
  const alertText = validation ?? error;
  const pickInvalid = validation === PICK_ONE_COPY;
  const optionOrder: readonly Choice[] =
    mode.kind === 'thread' ? ['this', 'all', 'some'] : ['all', 'some'];

  function handleRadioKeys(event: React.KeyboardEvent<HTMLDivElement>): void {
    if ((event.target as HTMLElement).getAttribute('role') !== 'radio') return;
    const step = ARROW_STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const at = optionOrder.indexOf(choice);
    const next = optionOrder[(at + step + optionOrder.length) % optionOrder.length];
    if (next === undefined) return;
    select(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-choice="${next}"]`)?.focus();
  }
  const label = pending
    ? `Sharing… ${upload?.progress ?? 100}%`
    : shareButtonLabel(audience, clientPartyName);

  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-[17px]">Share a file</DialogTitle>
      </DialogHeader>

      {mode.kind === 'thread' ? (
        upload !== null && <UploadTile upload={upload} />
      ) : (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${ids}-file`} className="text-muted-foreground text-xs font-medium">
            File
          </label>
          <input
            id={`${ids}-file`}
            type="file"
            accept={REQUEST_FILE_ACCEPT}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file !== undefined) {
                setValidation(null);
                onPickFile?.(file);
              }
              e.target.value = '';
            }}
            className="border-border text-foreground focus-visible:ring-ring min-h-11 w-full rounded-lg border px-2.5 py-1.5 text-[13px] focus-visible:ring-2 focus-visible:outline-none"
          />
          {upload !== null && <UploadTile upload={upload} />}
        </div>
      )}

      {upload?.status === 'failed' && (
        <button
          type="button"
          onClick={onRetryUpload}
          className="border-border bg-card text-foreground focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 self-start rounded-lg border px-3 text-[13px] font-medium focus-visible:ring-2 focus-visible:outline-none"
        >
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          Try the upload again
        </button>
      )}

      {showOptions && (
        <div
          role="radiogroup"
          aria-labelledby={`${ids}-audience`}
          onKeyDown={handleRadioKeys}
          className="mt-1 flex flex-col gap-2"
        >
          <span id={`${ids}-audience`} className="text-muted-foreground text-xs font-medium">
            Who can see it
          </span>
          {mode.kind === 'thread' && (
            <OptionCard
              value="this"
              selected={choice === 'this'}
              icon={Lock}
              title={
                threadTrack === undefined
                  ? 'Share with this expert'
                  : `${firstNameOf(threadTrack.trackName)} only`
              }
              sub="Just this conversation."
              onSelect={() => select('this')}
            />
          )}
          <OptionCard
            value="all"
            selected={choice === 'all'}
            icon={Users}
            title={`All interested experts · ${liveTracks.length}`}
            sub="Experts who express interest later will also see this file."
            onSelect={() => select('all')}
          />
          <OptionCard
            value="some"
            selected={choice === 'some'}
            icon={Lock}
            title="Only specific experts"
            sub="For sensitive documents — an NDA-gated contract, for example."
            onSelect={() => select('some')}
          >
            <ExpertChecklist
              tracks={liveTracks}
              picks={picks}
              threadId={threadId}
              invalid={pickInvalid}
              describedBy={`${ids}-alert`}
              onToggle={togglePick}
            />
          </OptionCard>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-note`} className="text-muted-foreground text-xs font-medium">
          Note (optional)
        </label>
        <textarea
          id={`${ids}-note`}
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a note to go with the file"
          className="border-border bg-card text-foreground placeholder:text-muted-foreground focus-visible:ring-ring resize-y rounded-[10px] border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />
      </div>

      {excludesThisThread && (
        <p className="text-warning-strong text-[12.5px]">
          This file won&apos;t appear in this conversation. Only {joinNames(excludedNames)} will see
          it.
        </p>
      )}
      {showOptions && reachedIds.length > 1 && (
        <p className="text-muted-foreground text-[12.5px]">
          Your note goes with the file to everyone it&apos;s shared with.
        </p>
      )}
      {alertText !== null && (
        <p id={`${ids}-alert`} role="alert" className="text-destructive text-[12.5px]">
          {alertText}
        </p>
      )}

      <DialogFooter className="flex-row flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={confirming}
          className="border-border bg-card text-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 items-center rounded-lg border px-3.5 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
        >
          Cancel
        </button>
        <button
          type="button"
          aria-busy={pending || undefined}
          onClick={handleShare}
          className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3.5 text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {label}
          {!pending && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
      </DialogFooter>
    </>
  );
}
