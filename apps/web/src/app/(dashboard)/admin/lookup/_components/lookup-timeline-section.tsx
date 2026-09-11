'use client';

import { useEffect, useRef, useState } from 'react';
import { History } from 'lucide-react';
import * as Sentry from '@sentry/nextjs';
import type {
  LookupEntityType,
  LookupTimelineCursorDTO,
  LookupTimelineEntry,
} from '@balo/shared/lookup';
import { cn } from '@/lib/utils';
import { LOOKUP_TYPE_LABEL } from '../_lib/lookup-view';
import { fetchLookupTimelineAction } from '../_actions/fetch-lookup-timeline';
import { LookupSectionRetryNotice } from './lookup-section-retry-notice';

/**
 * BAL-555 — the drill-in's Timeline section: the selected entity's `audit_events` rows,
 * action name in a monospace face, what happened in plain words, when. Keyset-paginated
 * backwards from newest, rendered oldest-first once loaded.
 *
 * ⚠ RENDERING THIS WRITES NOTHING (PR #273 D3). No `log.info` here either — a read that
 * fetches on selection is not a business event.
 *
 * ⚠ THE PRE-`0088` CAVEAT (C4): pre-migration rows carry an arbitrary `seq` (physical scan
 * order), so this component makes NO ordinal claim it cannot support — no numbering, no
 * "first/then/last" copy. Rows sharing one `occurredAtIso` instant render under ONE visible
 * timestamp as one change (ADR-1030's meaning of `created_at`).
 *
 * ⚠ NO MONEY, NO FEE FIGURE (C3) — enforced upstream by `describeAuditEvent`; this component
 * never reads `metadata` (the DTO never carries it).
 *
 * ⚠ `engagement_milestone` ROWS OTHER THAN `reordered` ARE NOT UNIONED IN for an engagement's
 * trail (see `repositories/audit-events.ts`'s reader docblock) — a known, documented v1 gap,
 * not a rendering defect here.
 *
 * The `lookup-money-section.tsx` state machine, copied deliberately: a `requestIdRef` guard so
 * a stale in-flight fetch can never clobber a newer one, and a `retryToken` the Retry button
 * bumps independently of the entity-keyed effect.
 */

interface LookupTimelineSectionProps {
  readonly entityType: LookupEntityType;
  readonly entityId: string;
  /** true when the tab bar is rendered; false when this is the lone labelled SECTION (C2). */
  readonly labelled: boolean;
}

interface LoadedTimeline {
  readonly entries: readonly LookupTimelineEntry[];
  readonly hasEarlier: boolean;
  readonly earlier: LookupTimelineCursorDTO | null;
}

type TimelineFetchState =
  | 'loading'
  | { readonly ok: true; readonly data: LoadedTimeline }
  | { readonly ok: false; readonly reason: 'forbidden' | 'not_found' | 'unavailable' };

const SKELETON_ROW_KEYS = ['a', 'b', 'c'] as const;

function LoadingSkeleton(): React.JSX.Element {
  return (
    <output aria-busy="true" className="block">
      <span className="sr-only">Loading timeline…</span>
      <div className="space-y-3">
        {SKELETON_ROW_KEYS.map((key) => (
          <div key={key} className="grid grid-cols-[14px_1fr_auto] items-start gap-x-3">
            <div className="bg-muted mt-1 size-2 shrink-0 animate-pulse rounded-full" />
            <div className="space-y-1.5">
              <div className="bg-muted h-3 w-20 animate-pulse rounded" />
              <div className="bg-muted h-3 w-full animate-pulse rounded" />
            </div>
            <div className="bg-muted h-3 w-10 animate-pulse rounded" />
          </div>
        ))}
      </div>
    </output>
  );
}

const REASON_COPY: Record<'forbidden' | 'not_found' | 'unavailable', string> = {
  forbidden: "Timeline needs platform-admin access, which this account doesn't have.",
  not_found: "This record's timeline isn't available.",
  unavailable: "The timeline didn't load. Nothing was changed — retry below.",
};

function formatTimestamp(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/** Consecutive entries sharing ONE `occurredAtIso` instant become one connector group (C4). */
function groupByInstant(
  entries: readonly LookupTimelineEntry[]
): (readonly LookupTimelineEntry[])[] {
  const groups: LookupTimelineEntry[][] = [];
  for (const entry of entries) {
    const currentGroup = groups[groups.length - 1];
    const groupHead = currentGroup?.[0];
    if (groupHead !== undefined && groupHead.occurredAtIso === entry.occurredAtIso) {
      currentGroup?.push(entry);
    } else {
      groups.push([entry]);
    }
  }
  return groups;
}

export function LookupTimelineSection({
  entityType,
  entityId,
  labelled,
}: Readonly<LookupTimelineSectionProps>): React.JSX.Element {
  const [state, setState] = useState<TimelineFetchState>('loading');
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  // BAL-555 fix round F1 — a failed "Load earlier" used to be silently swallowed: the spinner
  // flipped back and nothing else happened, no message, no log. This mirrors the top-level
  // failure state's REASON_COPY vocabulary, scoped to the button rather than replacing the
  // already-loaded rows above it.
  const [loadEarlierError, setLoadEarlierError] = useState<
    'forbidden' | 'not_found' | 'unavailable' | null
  >(null);
  const requestIdRef = useRef(0);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState('loading');

    fetchLookupTimelineAction({ type: entityType, id: entityId })
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        if (result.ok) {
          setState({
            ok: true,
            data: {
              entries: result.entries,
              hasEarlier: result.hasEarlier,
              earlier: result.earlier,
            },
          });
        } else {
          setState({ ok: false, reason: result.reason });
        }
      })
      .catch(() => {
        if (requestIdRef.current === requestId) setState({ ok: false, reason: 'unavailable' });
      });
  }, [entityType, entityId, retryToken]);

  async function handleLoadEarlier(): Promise<void> {
    if (state === 'loading' || !state.ok || state.data.earlier === null) return;
    const cursor = state.data.earlier;
    setIsLoadingEarlier(true);
    setLoadEarlierError(null);
    try {
      const result = await fetchLookupTimelineAction({
        type: entityType,
        id: entityId,
        before: cursor,
      });
      if (result.ok) {
        setState((current) => {
          if (current === 'loading' || !current.ok) return current;
          return {
            ok: true,
            data: {
              entries: [...result.entries, ...current.data.entries],
              hasEarlier: result.hasEarlier,
              earlier: result.earlier,
            },
          };
        });
      } else {
        // Already-loaded rows above stay exactly as they are — only the button's own line
        // reports the failure.
        setLoadEarlierError(result.reason);
      }
    } catch (error) {
      // A client component: the server-only Pino logger (`@/lib/logging`) can't run here —
      // Turbopack refuses to bundle its `async_hooks` import into a browser chunk. Sentry is
      // this codebase's established client-side caught-error channel (see
      // `booking-flow-dialog.tsx`, `reschedule-proposal-card.tsx`).
      Sentry.captureException(error, {
        tags: { feature: 'admin-lookup', step: 'timeline_load_earlier' },
        extra: { entityType, entityId },
      });
      setLoadEarlierError('unavailable');
    } finally {
      setIsLoadingEarlier(false);
    }
  }

  const containerClassName = labelled
    ? 'border-warning/30 bg-warning/5 rounded-xl border p-3.5'
    : '';

  if (state === 'loading') {
    return (
      <div className={containerClassName}>
        <LoadingSkeleton />
      </div>
    );
  }

  if (!state.ok) {
    return (
      <LookupSectionRetryNotice
        containerClassName={containerClassName}
        message={REASON_COPY[state.reason]}
        showRetry={state.reason === 'unavailable'}
        onRetry={() => setRetryToken((token) => token + 1)}
      />
    );
  }

  const { entries, hasEarlier } = state.data;

  const eyebrow = labelled ? (
    <div className="mb-2 flex items-center gap-1.5">
      <History className="text-warning size-3" aria-hidden="true" />
      <span className="text-warning text-[11px] font-bold tracking-wide uppercase">Timeline</span>
      <span className="text-muted-foreground text-[11px]">· every change to this record</span>
    </div>
  ) : null;

  if (entries.length === 0 && !hasEarlier) {
    return (
      <div className={containerClassName}>
        {eyebrow}
        <p className="text-muted-foreground text-xs leading-relaxed">
          {/* pending-MJ — purely retrospective data the viewer cannot act on: the
              invitation-framing rule (balo-ui-skill) applies to sections the user could act
              from, and there is nothing to do from an audit trail. */}
          {`Nothing has been recorded against this ${LOOKUP_TYPE_LABEL[entityType].toLowerCase()} yet. Rows appear here the moment something changes.`}
        </p>
      </div>
    );
  }

  const groups = groupByInstant(entries);

  return (
    <div className={containerClassName}>
      {eyebrow}
      {hasEarlier && (
        <div className="mb-2">
          <button
            type="button"
            onClick={() => {
              // handleLoadEarlier catches every failure itself (sets loadEarlierError, logs)
              // and never rejects — this `.catch()` is a backstop against a future regression,
              // not a path this component relies on today.
              handleLoadEarlier().catch(() => {
                setLoadEarlierError('unavailable');
              });
            }}
            disabled={isLoadingEarlier}
            className="text-primary focus-visible:ring-ring inline-flex min-h-[44px] items-center rounded px-1 text-xs font-semibold underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
          >
            {isLoadingEarlier ? 'Loading earlier…' : 'Load earlier'}
          </button>
          {loadEarlierError !== null && (
            <p className="text-muted-foreground mt-1 text-xs">{REASON_COPY[loadEarlierError]}</p>
          )}
        </div>
      )}

      <div className="flex flex-col">
        {groups.map((group, groupIndex) => {
          const [head] = group;
          if (head === undefined) return null;
          const isLastGroup = groupIndex === groups.length - 1;

          return (
            <div
              key={head.id}
              className="grid grid-cols-[14px_1fr_auto] items-start gap-x-3 py-1.5"
            >
              <div className="flex h-full flex-col items-center">
                <span
                  aria-hidden="true"
                  className={cn(
                    'mt-1.5 size-2 shrink-0 rounded-full',
                    isLastGroup ? 'bg-primary' : 'bg-muted-foreground/40'
                  )}
                />
                {!isLastGroup && <span aria-hidden="true" className="bg-border mt-1 w-px flex-1" />}
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                {group.map((entry) => (
                  <div key={entry.id}>
                    <div className="font-mono text-xs font-semibold">{entry.action}</div>
                    <p className="text-muted-foreground text-[12.5px] leading-relaxed">
                      {entry.summary}
                    </p>
                  </div>
                ))}
              </div>
              <time
                dateTime={head.occurredAtIso}
                title={head.occurredAtIso}
                className="text-muted-foreground pt-0.5 text-[11.5px] whitespace-nowrap tabular-nums"
              >
                {formatTimestamp(head.occurredAtIso)}
              </time>
            </div>
          );
        })}
      </div>

      <p className="text-muted-foreground mt-3 text-[11px] leading-relaxed">
        From audit_events — every row was written in the same transaction as the change it records.
      </p>
    </div>
  );
}
