'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Inbox } from 'lucide-react';
import {
  ANY_SEQUENCE_EXEMPT,
  FOOTNOTE,
  LIMIT_EXEMPT_TAIL,
  SEQUENCE_META,
  truncationNotices,
  type FollowUpLimitView,
  type FollowUpWaitView,
  type LookupFollowUpType,
  type LookupFollowUpsResult,
  type LookupFollowUpsView,
} from '../_lib/follow-ups-view';
import { fetchLookupFollowUpsAction } from '../_actions/fetch-lookup-follow-ups';
import { LookupSectionRetryNotice } from './lookup-section-retry-notice';
import { WaitBlock } from './lookup-follow-up-wait-block';

/**
 * BAL-666 — the drill-in's Follow-ups tab: what is waiting on a person (users and experts) or
 * on whom a thing waits (project requests, and an engagement's originating request), and what
 * happened to each scheduled follow-up. Design reference `lookup-follow-ups.jsx`.
 *
 * ⚠ READ-ONLY. Opening the tab writes nothing and sends nothing; there is no resend, pause or
 * mute control here.
 *
 * The fetch lifecycle copies `lookup-money-section.tsx`: a `requestIdRef` guard so a stale
 * in-flight fetch can never clobber a newer one, and a `retryToken` the Retry button bumps.
 *
 * Every block starts closed, except that a lone wait opens itself: with one wait there is
 * nothing to scan.
 */

interface LookupFollowUpsSectionProps {
  readonly entityType: LookupFollowUpType;
  readonly entityId: string;
}

type FollowUpsState = 'loading' | LookupFollowUpsResult;

const SKELETON_BLOCKS = [
  { key: 'a', height: 'h-16' },
  { key: 'b', height: 'h-32' },
  { key: 'c', height: 'h-32' },
] as const;

function LoadingSkeleton(): React.JSX.Element {
  return (
    <output aria-busy="true" className="block">
      <span className="sr-only">Loading follow-ups…</span>
      <div className="flex flex-col gap-2.5">
        {SKELETON_BLOCKS.map((block) => (
          <div
            key={block.key}
            className={`bg-muted w-full animate-pulse rounded-xl motion-reduce:animate-none ${block.height}`}
          />
        ))}
      </div>
    </output>
  );
}

const ERROR_TITLE = 'Follow-ups could not be loaded';
const ERROR_BODY =
  'Something went wrong on our side. Nothing was changed, and nothing was sent by opening this tab.';

const REASON_COPY: Record<'forbidden' | 'not_found', string> = {
  forbidden: "Follow-ups need platform-admin access, which this account doesn't have.",
  not_found: "This record's follow-ups aren't available.",
};

function OriginNote({
  view,
  className,
}: Readonly<{ view: LookupFollowUpsView; className: string }>): React.JSX.Element | null {
  const showsProposalWait = [...view.now, ...view.earlier].some(
    (wait) => wait.title === SEQUENCE_META.proposal_review.title
  );
  if (view.origin === null || !showsProposalWait) return null;
  return (
    <p className={className}>
      Proposal follow-ups here are from {view.origin.requestTitle}, the request this engagement came
      from.
    </p>
  );
}

function EmptyState({ view }: Readonly<{ view: LookupFollowUpsView }>): React.JSX.Element {
  const heading =
    view.lens === 'person'
      ? `Nothing is waiting on ${view.subjectFirstName ?? 'this person'}`
      : 'Nothing here is waiting on anyone';
  return (
    <div className="px-3 py-6 text-center">
      <Inbox className="text-muted-foreground mx-auto size-[22px]" aria-hidden="true" />
      <p className="text-foreground mt-2.5 text-sm font-bold">{heading}</p>
      <p className="text-muted-foreground mt-1 text-[12.5px] leading-normal">
        No follow-ups were sent or skipped in the last 90 days. When something waits on a person,
        each follow-up shows here with what happened to it.
      </p>
      <OriginNote view={view} className="text-muted-foreground mt-2 text-xs leading-relaxed" />
    </div>
  );
}

function slotColour(filled: boolean, full: boolean): string {
  if (!filled) return 'bg-border';
  return full ? 'bg-warning' : 'bg-primary';
}

function LimitStrip({
  limit,
  firstName,
}: Readonly<{ limit: FollowUpLimitView; firstName: string | null }>): React.JSX.Element {
  const { used, of, full } = limit;
  const slots = Array.from({ length: of }, (_, slot) => slot);
  return (
    <div
      className={
        full
          ? 'border-warning/30 bg-warning/10 mb-4 flex flex-wrap items-center gap-2.5 rounded-[10px] border px-3 py-2.5'
          : 'border-border/60 bg-muted mb-4 flex flex-wrap items-center gap-2.5 rounded-[10px] border px-3 py-2.5'
      }
    >
      <span className="inline-flex gap-1" aria-hidden="true">
        {slots.map((slot) => (
          <span
            key={`limit-slot-${slot}`}
            className={`h-1.5 w-3.5 rounded-sm ${slotColour(slot < used, full)}`}
          />
        ))}
      </span>
      <span className="text-foreground text-[12.5px] font-semibold">
        {used} of {of} follow-up emails today
      </span>
      {(full || ANY_SEQUENCE_EXEMPT) && (
        <span className="text-muted-foreground text-xs">
          {full && `The next one due for ${firstName ?? 'this person'} today is skipped. `}
          {ANY_SEQUENCE_EXEMPT && LIMIT_EXEMPT_TAIL}
        </span>
      )}
    </div>
  );
}

function SectionLabel({
  children,
  right,
}: Readonly<{ children: React.ReactNode; right?: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-2.5">
      <p className="text-muted-foreground text-xs font-bold tracking-wider uppercase">{children}</p>
      {right}
    </div>
  );
}

function initiallyOpen(view: LookupFollowUpsView): ReadonlySet<string> {
  if (view.now.length === 1 && view.now[0] !== undefined) return new Set([view.now[0].id]);
  const [only] = [...view.now, ...view.earlier];
  if (view.now.length + view.earlier.length === 1 && only !== undefined) return new Set([only.id]);
  return new Set();
}

function WaitList({
  waits,
  lens,
  open,
  onToggle,
}: Readonly<{
  waits: readonly FollowUpWaitView[];
  lens: LookupFollowUpsView['lens'];
  open: ReadonlySet<string>;
  onToggle: (id: string) => void;
}>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      {waits.map((wait) => (
        <WaitBlock
          key={wait.id}
          wait={wait}
          lens={lens}
          open={open.has(wait.id)}
          onToggle={() => onToggle(wait.id)}
        />
      ))}
    </div>
  );
}

function LoadedFollowUps({
  view,
  open,
  setOpen,
}: Readonly<{
  view: LookupFollowUpsView;
  open: ReadonlySet<string>;
  setOpen: (next: ReadonlySet<string>) => void;
}>): React.JSX.Element {
  const all = [...view.now, ...view.earlier].map((wait) => wait.id);
  const allOpen = all.every((id) => open.has(id));

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setOpen(next);
    },
    [open, setOpen]
  );

  const toggleAll = useCallback(() => {
    setOpen(allOpen ? new Set() : new Set(all));
  }, [all, allOpen, setOpen]);

  const expandControl =
    all.length > 1 ? (
      <button
        type="button"
        onClick={toggleAll}
        className="text-primary focus-visible:ring-ring inline-flex min-h-[44px] items-center rounded px-1 text-xs font-semibold hover:underline focus-visible:ring-2 focus-visible:outline-none"
      >
        {allOpen ? 'Collapse all' : 'Expand all'}
      </button>
    ) : null;

  return (
    <div className="animate-in fade-in duration-300 motion-reduce:animate-none">
      <OriginNote view={view} className="text-muted-foreground mb-3 text-xs leading-relaxed" />
      {truncationNotices(view.truncated).map((notice) => (
        <p key={notice} className="text-muted-foreground mb-3 text-xs leading-relaxed">
          {notice}
        </p>
      ))}
      {view.limit !== null && <LimitStrip limit={view.limit} firstName={view.subjectFirstName} />}
      <SectionLabel right={expandControl}>Waiting now · {view.now.length}</SectionLabel>
      <WaitList waits={view.now} lens={view.lens} open={open} onToggle={toggle} />
      {view.earlier.length > 0 && (
        <div className="mt-5">
          <SectionLabel>Earlier · last 90 days</SectionLabel>
          <WaitList waits={view.earlier} lens={view.lens} open={open} onToggle={toggle} />
        </div>
      )}
      <p className="text-muted-foreground mt-3.5 text-[11px] leading-normal">{FOOTNOTE}</p>
    </div>
  );
}

export function LookupFollowUpsSection({
  entityType,
  entityId,
}: Readonly<LookupFollowUpsSectionProps>): React.JSX.Element {
  const [state, setState] = useState<FollowUpsState>('loading');
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const requestIdRef = useRef(0);
  const [retryToken, setRetryToken] = useState(0);
  const regionRef = useRef<HTMLDivElement>(null);
  const refocusRegionRef = useRef(false);

  useEffect(() => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState('loading');

    fetchLookupFollowUpsAction({ type: entityType, id: entityId })
      .then((result) => {
        if (requestIdRef.current !== requestId) return;
        setOpen(result.ok ? initiallyOpen(result.view) : new Set());
        setState(result);
      })
      .catch(() => {
        if (requestIdRef.current === requestId) {
          setState({ ok: false, reason: 'unavailable' });
        }
      });
  }, [entityType, entityId, retryToken]);

  // The Retry button unmounts with the error notice, which would drop focus to the page body: hand
  // it to the region that stays mounted through loading and loaded.
  useEffect(() => {
    if (state === 'loading' && refocusRegionRef.current) {
      refocusRegionRef.current = false;
      regionRef.current?.focus();
    }
  }, [state]);

  const handleRetry = useCallback(() => {
    refocusRegionRef.current = true;
    setRetryToken((token) => token + 1);
  }, []);

  return (
    <div ref={regionRef} tabIndex={-1} className="outline-none">
      <SectionBody state={state} open={open} setOpen={setOpen} onRetry={handleRetry} />
    </div>
  );
}

function SectionBody({
  state,
  open,
  setOpen,
  onRetry,
}: Readonly<{
  state: FollowUpsState;
  open: ReadonlySet<string>;
  setOpen: (next: ReadonlySet<string>) => void;
  onRetry: () => void;
}>): React.JSX.Element {
  if (state === 'loading') return <LoadingSkeleton />;

  if (!state.ok) {
    const unavailable = state.reason === 'unavailable';
    return (
      <LookupSectionRetryNotice
        containerClassName="px-3 py-6 text-center"
        title={unavailable ? ERROR_TITLE : undefined}
        message={unavailable ? ERROR_BODY : REASON_COPY[state.reason]}
        showRetry={unavailable}
        onRetry={onRetry}
      />
    );
  }

  const { view } = state;
  if (view.now.length === 0 && view.earlier.length === 0) {
    return <EmptyState view={view} />;
  }
  return <LoadedFollowUps view={view} open={open} setOpen={setOpen} />;
}
