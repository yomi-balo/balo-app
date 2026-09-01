'use client';

import { useState } from 'react';
import { Users, Lock, Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
// ⚠ FROM THE CLIENT-SAFE CONSTRAINTS MODULE, not `@/lib/storage/request-file` — that one is
// `server-only`. `REQUEST_FILE_ACCEPT` is its verbatim re-export of this same constant.
import { CONVERSATION_FILE_ACCEPT as REQUEST_FILE_ACCEPT } from '@/lib/storage/conversation-file-constraints';

export interface ShareFileTrack {
  relationshipId: string;
  trackName: string;
}

export type ShareFileMode = 'all_live_tracks' | 'grants';

interface ShareFileSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  liveTracks: ShareFileTrack[];
  submitting: boolean;
  onSubmit: (mode: ShareFileMode, relationshipIds: string[], file: File) => void;
}

/**
 * BAL-431 §7.2 — the share picker. Audience picker lists LIVE TRACKS ONLY (a closed track is
 * never an offerable target — the repository re-validates in-transaction regardless). Submit is
 * disabled when `grants` mode has zero picks.
 */
export function ShareFileSheet({
  open,
  onOpenChange,
  liveTracks,
  submitting,
  onSubmit,
}: Readonly<ShareFileSheetProps>): React.JSX.Element {
  const [mode, setMode] = useState<ShareFileMode>('all_live_tracks');
  const [picks, setPicks] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);

  function togglePick(relationshipId: string): void {
    setPicks((current) =>
      current.includes(relationshipId)
        ? current.filter((id) => id !== relationshipId)
        : [...current, relationshipId]
    );
  }

  function reset(): void {
    setMode('all_live_tracks');
    setPicks([]);
    setFile(null);
  }

  function handleOpenChange(next: boolean): void {
    if (!next) reset();
    onOpenChange(next);
  }

  const disabled = file === null || submitting || (mode === 'grants' && picks.length === 0);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share a file</DialogTitle>
          <DialogDescription>Choose who can see it.</DialogDescription>
        </DialogHeader>

        <label className="text-muted-foreground text-xs font-medium" htmlFor="request-file-picker">
          File
        </label>
        <input
          id="request-file-picker"
          type="file"
          accept={REQUEST_FILE_ACCEPT}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="border-border text-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
        />

        <div className="mt-4 space-y-2">
          <button
            type="button"
            onClick={() => setMode('all_live_tracks')}
            className={
              'focus-visible:ring-ring flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left focus-visible:ring-2 focus-visible:outline-none ' +
              (mode === 'all_live_tracks'
                ? 'border-primary bg-muted'
                : 'border-border hover:border-primary/50')
            }
          >
            <Users className="text-primary mt-0.5 h-4 w-4" aria-hidden="true" />
            <span>
              <span className="block text-sm font-medium">
                Everyone invited · {liveTracks.length} expert{liveTracks.length === 1 ? '' : 's'}
              </span>
              <span className="text-muted-foreground block text-xs">
                Experts invited later will also see this file.
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => setMode('grants')}
            className={
              'focus-visible:ring-ring flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left focus-visible:ring-2 focus-visible:outline-none ' +
              (mode === 'grants'
                ? 'border-primary bg-muted'
                : 'border-border hover:border-primary/50')
            }
          >
            <Lock className="text-primary mt-0.5 h-4 w-4" aria-hidden="true" />
            <span>
              <span className="block text-sm font-medium">Only specific experts</span>
              <span className="text-muted-foreground block text-xs">
                For sensitive documents — an NDA-gated contract, for example.
              </span>
            </span>
          </button>

          {mode === 'grants' && (
            <div className="border-border rounded-lg border p-2">
              {liveTracks.map((t) => (
                <label
                  key={t.relationshipId}
                  className="hover:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm"
                >
                  <Checkbox
                    checked={picks.includes(t.relationshipId)}
                    onCheckedChange={() => togglePick(t.relationshipId)}
                  />
                  {t.trackName}
                </label>
              ))}
              {liveTracks.length === 0 && (
                <p className="text-muted-foreground px-2 py-1.5 text-xs">
                  No live experts to pick from.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => handleOpenChange(false)}
            className="border-border hover:bg-muted focus-visible:ring-ring rounded-md border px-3 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => file !== null && onSubmit(mode, mode === 'grants' ? picks : [], file)}
            className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Sharing…' : 'Share'}
            {!submitting && <Check className="h-3.5 w-3.5" aria-hidden="true" />}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
