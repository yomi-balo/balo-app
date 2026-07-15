'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion, useReducedMotion } from 'motion/react';
import { AlertCircle, CalendarClock, Eye, Loader2, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatUtcLongDate, formatUtcShortDate } from '@/lib/format/local-date';
import type { SharedLinkView } from '@/lib/project-request/proposal/share-view-types';
import { revokeProposalShareLink } from '@/app/(dashboard)/projects/[requestId]/proposal/[relationshipId]/_actions/share';

export type SharedWithCardStatus = 'loaded' | 'loading' | 'error';

interface SharedWithCardProps {
  requestId: string;
  relationshipId: string;
  links: SharedLinkView[];
  /** Server-resolved load outcome. Defaults to `loaded`; `error` when the fetch threw. */
  status?: SharedWithCardStatus;
}

function SectionLabel(): React.JSX.Element {
  return (
    <span className="text-muted-foreground text-[11px] font-bold tracking-[0.08em] uppercase">
      Shared with
    </span>
  );
}

function LoadingRows(): React.JSX.Element {
  return (
    <div className="mt-2.5" aria-hidden="true">
      {[0, 1].map((i) => (
        <div
          key={i}
          className={cn(
            'flex items-center justify-between gap-3 py-3',
            i === 0 && 'border-border border-b'
          )}
        >
          <div className="flex-1">
            <div className="bg-muted h-3.5 w-1/2 animate-pulse rounded" />
            <div className="bg-muted mt-2 h-2.5 w-1/3 animate-pulse rounded" />
          </div>
          <div className="bg-muted h-7 w-16 animate-pulse rounded-lg" />
        </div>
      ))}
    </div>
  );
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center px-3 py-5 text-center">
      <span className="border-border bg-muted/40 mb-2.5 flex h-10 w-10 items-center justify-center rounded-xl border border-dashed">
        <Mail className="text-muted-foreground h-4 w-4" aria-hidden="true" />
      </span>
      <p className="text-muted-foreground text-[13px] leading-relaxed">
        No one outside your team has access yet.
      </p>
    </div>
  );
}

/**
 * "Shared with" list on the client proposal view (BAL-386, Surface 1c). Renders the
 * external colleagues a proposal has been shared with, with an inline-confirm revoke
 * ("Withdraw access?"). All four async states: loaded / loading / error / empty. The
 * empty state stays as an invitation (never hidden). Tokens/hashes never reach here
 * — rows carry only email + shared/last-opened dates.
 */
export function SharedWithCard({
  requestId,
  relationshipId,
  links,
  status = 'loaded',
}: Readonly<SharedWithCardProps>): React.JSX.Element {
  const router = useRouter();
  const reduce = useReducedMotion();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const handleRetry = useCallback((): void => {
    router.refresh();
  }, [router]);

  const handleRevoke = useCallback(
    (linkId: string): void => {
      setPendingId(linkId);
      const run = async (): Promise<void> => {
        try {
          const result = await revokeProposalShareLink({ requestId, relationshipId, linkId });
          if (!result.ok) {
            toast.error('Could not withdraw access. Please try again.');
            return;
          }
          toast.success('Access withdrawn');
          setConfirmingId(null);
          router.refresh();
        } catch {
          toast.error('Could not withdraw access. Please try again.');
        } finally {
          setPendingId(null);
        }
      };
      void run();
    },
    [requestId, relationshipId, router]
  );

  const isLoaded = status === 'loaded';
  const hasRows = isLoaded && links.length > 0;

  return (
    <div className="border-border bg-card rounded-2xl border p-5">
      <div className="mb-1 flex items-center justify-between">
        <SectionLabel />
        {hasRows && (
          <span className="border-primary/30 bg-primary/10 text-primary rounded-full border px-2.5 py-0.5 text-[11px] font-semibold">
            {links.length} active link{links.length > 1 ? 's' : ''}
          </span>
        )}
      </div>

      {status === 'loading' && <LoadingRows />}

      {status === 'error' && (
        <div className="border-destructive/30 bg-destructive/10 mt-2.5 flex items-start gap-2.5 rounded-lg border p-3">
          <AlertCircle className="text-destructive mt-px h-4 w-4 shrink-0" aria-hidden="true" />
          <p className="text-foreground text-[13px] leading-relaxed">
            We couldn&apos;t load who this proposal is shared with.{' '}
            <button
              type="button"
              onClick={handleRetry}
              className="text-primary focus-visible:ring-ring rounded font-semibold underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none"
            >
              Try again
            </button>
          </p>
        </div>
      )}

      {isLoaded && links.length === 0 && <EmptyState />}

      {hasRows && (
        <ul className="flex flex-col">
          {links.map((link, index) => {
            const pending = pendingId === link.id;
            return (
              <motion.li
                key={link.id}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={reduce ? undefined : { opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: 'easeOut', delay: reduce ? 0 : index * 0.05 }}
                className={cn(
                  'flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3',
                  index < links.length - 1 && 'border-border border-b'
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-foreground truncate text-[13.5px] font-semibold">
                    {link.recipientEmail}
                  </p>
                  <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                    <span>Shared {formatUtcShortDate(link.sharedOnIso)}</span>
                    <span className="inline-flex items-center gap-1">
                      <Eye className="h-3 w-3" aria-hidden="true" />
                      {link.lastAccessedIso === null
                        ? 'Not opened yet'
                        : `Last opened ${formatUtcShortDate(link.lastAccessedIso)}`}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <CalendarClock className="h-3 w-3" aria-hidden="true" />
                      Works until {formatUtcLongDate(link.expiresAtIso)}
                    </span>
                  </div>
                </div>

                {confirmingId === link.id ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="text-foreground text-xs font-semibold">Withdraw access?</span>
                    <button
                      type="button"
                      onClick={() => handleRevoke(link.id)}
                      disabled={pending}
                      className="bg-destructive text-destructive-foreground focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60 sm:min-h-8"
                    >
                      {pending && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
                      Withdraw
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      disabled={pending}
                      className="border-border text-foreground focus-visible:ring-ring hover:bg-muted inline-flex min-h-11 items-center rounded-lg border px-3 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60 sm:min-h-8"
                    >
                      Keep
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingId(link.id)}
                    className="border-destructive/30 text-destructive focus-visible:ring-ring hover:bg-destructive/10 inline-flex min-h-11 shrink-0 items-center rounded-lg border px-3 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none sm:min-h-8"
                  >
                    Revoke
                  </button>
                )}
              </motion.li>
            );
          })}
        </ul>
      )}

      {hasRows && (
        <p className="text-muted-foreground border-border mt-3 border-t pt-3 text-[11.5px] leading-relaxed">
          Each link works only for the email it was sent to. Recipients can view the proposal but
          can&apos;t accept it or see your team&apos;s activity.
        </p>
      )}
    </div>
  );
}
