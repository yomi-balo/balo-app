'use client';

import { useState } from 'react';
import { Upload } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { RequestFilesView } from '@/lib/request-files/load-request-files';
import { ExpertClosureBanner } from './expert-closure-banner';
import { RequestFileRow } from './request-file-row';
import { useRequestFiles, type RequestFilesContextValue } from './request-files-provider';
import { firstNameOf } from './share-file-sheet';

interface RequestFilesSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The request brief's documents, listed above every shared file. */
  brief: React.ReactNode;
  /** Opens the share dialog in All-files mode. */
  onShareNew: () => void;
}

const ALL_FILTER = 'all';

/**
 * ⚠ `view.lens` IS THE LOADER'S VIEW-SHAPE DISCRIMINANT (assigned from the gate's
 * already-capability-checked side), not a role re-read in the browser: every branch below picks
 * which of three server-decided shapes to present. No mutation here reads it.
 */
function SheetTitleBlock({ view }: Readonly<{ view: RequestFilesView }>): React.JSX.Element {
  if (view.lens === 'client') {
    return (
      <>
        <SheetTitle className="text-[15px]">All files on this request</SheetTitle>
        <SheetDescription className="text-[12.5px]">
          You see every file. Experts see only what is shared with them.
        </SheetDescription>
      </>
    );
  }
  return (
    <>
      <SheetTitle className="text-[15px]">Files</SheetTitle>
      <SheetDescription className="sr-only">Files shared on this request.</SheetDescription>
    </>
  );
}

interface FilterChipsProps {
  tracks: ReadonlyArray<{ relationshipId: string; trackName: string }>;
  value: string;
  onChange: (value: string) => void;
}

/** "All" plus one "{first} can see" chip per live track. */
function FilterChips({ tracks, value, onChange }: Readonly<FilterChipsProps>): React.JSX.Element {
  const chips = [
    { id: ALL_FILTER, label: 'All' },
    ...tracks.map((t) => ({ id: t.relationshipId, label: `${firstNameOf(t.trackName)} can see` })),
  ];
  return (
    <div role="radiogroup" aria-label="Show files" className="flex flex-wrap gap-1.5">
      {chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          role="radio"
          aria-checked={value === chip.id}
          onClick={() => onChange(chip.id)}
          className={cn(
            'focus-visible:ring-ring inline-flex min-h-11 items-center rounded-full border px-3 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none sm:min-h-8',
            value === chip.id
              ? 'border-primary/40 bg-primary/5 text-primary'
              : 'border-border bg-card text-muted-foreground'
          )}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

interface SheetBodyProps {
  files: RequestFilesContextValue;
  filter: string;
}

function SheetRows({ files, filter }: Readonly<SheetBodyProps>): React.JSX.Element {
  const { view } = files;
  if (view.lens === 'admin') {
    return (
      <>
        {view.files.map((file) => (
          <RequestFileRow key={file.id} lens="admin" file={file} />
        ))}
      </>
    );
  }
  if (view.lens === 'expert') {
    return (
      <>
        {view.files.map((file) => (
          <RequestFileRow
            key={file.id}
            lens="expert"
            file={file}
            clientPartyName={view.clientPartyName}
            onDownload={files.download}
            onDelete={files.requestRemove}
            onPreview={() => files.preview(file, 'files_sheet')}
            previewingId={files.previewingId}
            downloadingId={files.downloadingId}
            deletingId={files.deletingId}
          />
        ))}
      </>
    );
  }
  const shown =
    filter === ALL_FILTER
      ? view.files
      : view.files.filter((f) => f.visibleToLiveTrackIds.includes(filter));
  return (
    <>
      {shown.map((file) => (
        <RequestFileRow
          key={file.id}
          lens="client"
          file={file}
          onDownload={files.download}
          onDelete={files.requestRemove}
          onRevoke={files.revoke}
          onPreview={() => files.preview(file, 'files_sheet')}
          previewingId={files.previewingId}
          downloadingId={files.downloadingId}
          deletingId={files.deletingId}
          revokingRelationshipId={files.revokingRelationshipId}
        />
      ))}
    </>
  );
}

/** The invitation shown when nothing has been shared (or nothing matches the filter). */
function emptyCopy(view: RequestFilesView, filter: string): string {
  if (view.lens === 'admin') return 'No files have been shared on this request yet.';
  if (view.lens === 'expert')
    return 'Share a file from the conversation. It goes to the client only.';
  const track = view.liveTracks.find((t) => t.relationshipId === filter);
  if (track !== undefined) {
    return `Nothing is shared with ${firstNameOf(track.trackName)} yet. Share a file from their conversation.`;
  }
  if (view.requestKind === 'direct') return 'Share a file from the conversation.';
  if (view.liveTracks.length === 0) return 'Files you share with experts will appear here.';
  return 'Share a file from the conversation, or with several experts below.';
}

function shownCount(view: RequestFilesView, filter: string): number {
  if (view.lens === 'client' && filter !== ALL_FILTER) {
    return view.files.filter((f) => f.visibleToLiveTrackIds.includes(filter)).length;
  }
  return view.files.length;
}

/**
 * The full file list: the request brief, then every shared file the viewer can see. A client on
 * a matched request can filter to what one expert can see (the server computed that set, so the
 * chips can never disagree with the download gate) and can start a share with several experts.
 * Desktop opens a right drawer; mobile a bottom sheet.
 */
export function RequestFilesSheet({
  open,
  onOpenChange,
  brief,
  onShareNew,
}: Readonly<RequestFilesSheetProps>): React.JSX.Element | null {
  const files = useRequestFiles();
  const isMobile = useIsMobile();
  const [filter, setFilter] = useState(ALL_FILTER);
  if (files === null) return null;
  const { view } = files;
  const showFilter =
    view.lens === 'client' && view.requestKind === 'matched' && view.liveTracks.length > 1;
  const canShareNew = view.lens === 'client' && view.requestKind === 'matched';
  const activeFilter = showFilter ? filter : ALL_FILTER;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className={cn(
          'gap-0 p-0',
          isMobile ? 'max-h-[85dvh] rounded-t-2xl' : 'w-full sm:max-w-[420px]'
        )}
      >
        <SheetHeader className="border-border gap-2.5 border-b px-[18px] pt-4 pr-12 pb-3">
          <div>
            <SheetTitleBlock view={view} />
          </div>
          {showFilter && view.lens === 'client' && (
            <FilterChips tracks={view.liveTracks} value={activeFilter} onChange={setFilter} />
          )}
        </SheetHeader>

        {view.lens === 'expert' && view.closedReason !== null && (
          <ExpertClosureBanner reason={view.closedReason} />
        )}

        <ul className="divide-border flex-1 divide-y overflow-y-auto">
          <li className="px-4 py-3">{brief}</li>
          <SheetRows files={files} filter={activeFilter} />
          {shownCount(view, activeFilter) === 0 && (
            <li className="text-muted-foreground px-4 py-4 text-sm">
              {emptyCopy(view, activeFilter)}
            </li>
          )}
        </ul>

        {canShareNew && (
          <div className="border-border border-t p-3.5">
            <button
              type="button"
              onClick={onShareNew}
              className="border-border bg-card text-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg border text-sm font-medium focus-visible:ring-2 focus-visible:outline-none"
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              Share with several experts
            </button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
