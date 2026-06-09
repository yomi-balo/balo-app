'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { AlertCircle, Check, Loader2, Search, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import {
  searchExpertsForInviteAction,
  type ExpertInviteOption,
} from '@/app/(dashboard)/projects/[requestId]/_actions/search-experts-for-invite';
import { inviteExpertsAction } from '@/app/(dashboard)/projects/[requestId]/_actions/invite-experts';

interface ExpertInviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  /** expert_profiles.ids already on this request — shown disabled / pre-filtered. */
  alreadyInvitedIds: readonly string[];
}

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'loaded'; experts: ExpertInviteOption[] };

function deriveInitials(name: string): string {
  return (
    name
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

/**
 * Admin expert picker — searches experts via `searchExpertsForInviteAction`,
 * multi-selects, and persists via `inviteExpertsAction`. All four async states:
 * loading (spinner), empty ("No experts match"), error (retry), results
 * (selectable rows). Already-invited experts render disabled. Fires
 * `PROJECT_EXPERT_INVITED` per invite + `PROJECT_REQUEST_STATUS_TRANSITIONED` when
 * the request advanced.
 */
export function ExpertInviteDialog({
  open,
  onOpenChange,
  requestId,
  alreadyInvitedIds,
}: Readonly<ExpertInviteDialogProps>): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'idle' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isInviting, startInviting] = useTransition();
  const alreadyInvited = new Set(alreadyInvitedIds);

  const runSearch = useCallback(async (q: string): Promise<void> => {
    setLoadState({ kind: 'loading' });
    const result = await searchExpertsForInviteAction({ q: q.trim() || undefined });
    if (result.success) {
      setLoadState({ kind: 'loaded', experts: result.experts });
    } else {
      setLoadState({ kind: 'error' });
    }
  }, []);

  // Load on open; reset on close.
  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setQuery('');
      void runSearch('');
    }
  }, [open, runSearch]);

  // Debounced re-search as the query changes (only while open).
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runSearch(query);
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open, runSearch]);

  const toggle = useCallback((id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleInvite = useCallback((): void => {
    const expertProfileIds = Array.from(selected);
    if (expertProfileIds.length === 0) return;

    startInviting(async () => {
      const result = await inviteExpertsAction({ requestId, expertProfileIds });
      if (!result.success) {
        toast.error(result.error);
        return;
      }

      if (result.invitedCount === 0) {
        toast.info('Those experts were already invited.');
        onOpenChange(false);
        return;
      }

      for (const invitee of result.invited) {
        track(PROJECT_EVENTS.PROJECT_EXPERT_INVITED, {
          request_id: requestId,
          relationship_id: invitee.relationshipId,
          expert_id: invitee.expertProfileId,
          actor: 'admin',
        });
      }

      if (result.transitioned && result.from) {
        track(PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED, {
          request_id: requestId,
          from: result.from,
          to: 'experts_invited',
          actor: 'admin',
          ...(result.firstAdminActionMs !== undefined
            ? { time_to_first_admin_action_ms: result.firstAdminActionMs }
            : {}),
        });
      }

      toast.success(
        result.invitedCount === 1 ? '1 expert invited.' : `${result.invitedCount} experts invited.`
      );
      onOpenChange(false);
    });
  }, [selected, requestId, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite experts</DialogTitle>
          <DialogDescription>
            Search and select the specialists you want to invite to this request.
          </DialogDescription>
        </DialogHeader>

        {/* Search input */}
        <div className="relative">
          <Search
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search experts by name or expertise"
            aria-label="Search experts"
            className="border-input bg-background focus-visible:ring-ring h-10 w-full rounded-lg border pr-3 pl-9 text-sm focus-visible:ring-2 focus-visible:outline-none"
          />
        </div>

        {/* Results region — all four async states */}
        <div className="max-h-72 min-h-40 overflow-y-auto" aria-busy={loadState.kind === 'loading'}>
          {loadState.kind === 'loading' && (
            <div className="text-muted-foreground flex h-40 flex-col items-center justify-center gap-2 text-sm">
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
              <span>Loading experts…</span>
            </div>
          )}

          {loadState.kind === 'error' && (
            <div className="flex h-40 flex-col items-center justify-center gap-3 text-center">
              <AlertCircle className="text-destructive h-5 w-5" aria-hidden="true" />
              <p className="text-muted-foreground text-sm">Couldn&apos;t load experts.</p>
              <Button variant="outline" size="sm" onClick={() => void runSearch(query)}>
                Try again
              </Button>
            </div>
          )}

          {loadState.kind === 'loaded' && loadState.experts.length === 0 && (
            <div className="text-muted-foreground flex h-40 flex-col items-center justify-center gap-1 text-center text-sm">
              <p className="text-foreground font-medium">No experts match</p>
              <p>Try a different search.</p>
            </div>
          )}

          {loadState.kind === 'loaded' && loadState.experts.length > 0 && (
            <ul className="flex flex-col gap-1.5 py-1">
              {loadState.experts.map((expert) => {
                const isInvited = alreadyInvited.has(expert.id);
                const isSelected = selected.has(expert.id);
                return (
                  <li key={expert.id}>
                    <button
                      type="button"
                      disabled={isInvited}
                      aria-pressed={isSelected}
                      onClick={() => toggle(expert.id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
                        isInvited && 'cursor-not-allowed opacity-60',
                        !isInvited && isSelected && 'border-primary bg-primary/5',
                        !isInvited && !isSelected && 'border-border hover:bg-muted/50'
                      )}
                    >
                      <span className="bg-muted text-muted-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold">
                        {deriveInitials(expert.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-foreground block truncate text-sm font-medium">
                          {expert.name}
                        </span>
                        {expert.headline && (
                          <span className="text-muted-foreground block truncate text-xs">
                            {expert.headline}
                          </span>
                        )}
                      </span>
                      {isInvited ? (
                        <span className="text-muted-foreground shrink-0 text-xs font-medium">
                          Already invited
                        </span>
                      ) : (
                        <span
                          className={cn(
                            'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
                            isSelected
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border'
                          )}
                          aria-hidden="true"
                        >
                          {isSelected && <Check className="h-3.5 w-3.5" />}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isInviting}>
            Cancel
          </Button>
          <Button onClick={handleInvite} disabled={isInviting || selected.size === 0}>
            <UserPlus className="h-4 w-4" aria-hidden="true" />
            {isInviting
              ? 'Inviting…'
              : selected.size > 0
                ? `Invite ${selected.size} expert${selected.size === 1 ? '' : 's'}`
                : 'Invite experts'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
