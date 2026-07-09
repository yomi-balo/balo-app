'use client';

import { useCallback, useState } from 'react';
import { AlertTriangle, Globe, Loader2, Sparkles, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import type { PartyDomainWithCreator, PartyDomainSource } from '@balo/db';
import { Button } from '@/components/ui/button';
import { removePartyDomain } from '@/app/(dashboard)/settings/team/_actions/remove-domain';

type PartyType = 'company' | 'agency';

interface DomainCreator {
  firstName: string | null;
  lastName: string | null;
}

/** Full name of a domain's creator, or a neutral fallback when unattributed. */
export function creatorName(createdBy: DomainCreator | null): string {
  if (createdBy === null) return 'a teammate';
  const name = [createdBy.firstName, createdBy.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : 'a teammate';
}

/**
 * Source-aware attribution line (BAL-347): "Captured from {Name}" for an auto-captured
 * domain vs "Added by {Name}" for an admin-added one. On the person's FIRST mention in
 * the list we append "@ {party}" (which org they belong to); later mentions are bare.
 * An unattributed row skips the "@ {party}" suffix.
 */
export function attributionText(
  source: PartyDomainSource,
  createdBy: DomainCreator | null,
  firstMention: boolean,
  partyName: string
): string {
  const verb = source === 'auto_captured' ? 'Captured from' : 'Added by';
  const name = creatorName(createdBy);
  const suffix = firstMention && createdBy !== null ? ` @ ${partyName}` : '';
  return `${verb} ${name}${suffix}`;
}

function SourceBadge({ source }: Readonly<{ source: PartyDomainSource }>): React.JSX.Element {
  const isAuto = source === 'auto_captured';
  const Icon = isAuto ? Sparkles : UserPlus;
  return (
    <span
      title={isAuto ? 'Captured automatically from a signup' : 'Added by an admin'}
      className={
        isAuto
          ? 'bg-primary/10 text-primary border-primary/20 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold'
          : 'bg-muted text-muted-foreground border-border inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold'
      }
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {isAuto ? 'Auto-captured' : 'Admin-added'}
    </span>
  );
}

interface DomainRowProps {
  row: PartyDomainWithCreator;
  firstMention: boolean;
  partyType: PartyType;
  partyId: string;
  partyName: string;
  isLast: boolean;
}

export function DomainRow({
  row,
  firstMention,
  partyType,
  partyId,
  partyName,
  isLast,
}: Readonly<DomainRowProps>): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const startConfirm = useCallback((): void => setConfirming(true), []);
  const cancelConfirm = useCallback((): void => setConfirming(false), []);

  const confirmRemove = useCallback(async (): Promise<void> => {
    setIsBusy(true);
    try {
      const result = await removePartyDomain({ partyType, partyId, domainId: row.id });
      if (result.success) {
        toast.success('Domain removed');
        // The action revalidates the surface; the row disappears via the RSC refresh.
      } else {
        toast.error(result.error);
        setConfirming(false);
      }
    } finally {
      setIsBusy(false);
    }
  }, [partyType, partyId, row.id]);

  if (confirming) {
    return (
      <div className="border-destructive/25 bg-destructive/5 my-1 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3.5 py-3">
        <div className="flex min-w-[220px] flex-1 flex-col gap-1">
          <span className="text-foreground text-sm font-medium">{`Remove ${row.domain}?`}</span>
          <span
            className={
              isLast
                ? 'text-warning flex items-center gap-1.5 text-xs'
                : 'text-muted-foreground text-xs'
            }
          >
            {isLast && <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />}
            {isLast
              ? 'This is your last domain — removing it turns off join by domain entirely.'
              : "New signups on this domain won't be recognised."}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Button type="button" variant="ghost" size="sm" onClick={cancelConfirm} disabled={isBusy}>
            Keep
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={confirmRemove}
            disabled={isBusy}
            className="gap-1.5"
          >
            {isBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Remove
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 py-3">
      <span
        aria-hidden="true"
        className="bg-primary/10 text-primary flex h-9 w-9 flex-none items-center justify-center rounded-lg"
      >
        <Globe className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="text-foreground text-sm font-semibold">{row.domain}</span>
          <SourceBadge source={row.source} />
        </div>
        <p className="text-muted-foreground mt-0.5 text-xs">
          {attributionText(row.source, row.createdBy, firstMention, partyName)}
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={startConfirm}
        aria-label={`Remove ${row.domain}`}
        className="text-destructive hover:text-destructive gap-1.5"
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        Remove
      </Button>
    </div>
  );
}
