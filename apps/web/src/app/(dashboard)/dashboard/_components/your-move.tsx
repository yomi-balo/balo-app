'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { CheckCircle2, ChevronLeft, ChevronRight } from 'lucide-react';
import {
  DASHBOARD_YOUR_MOVE_CARD_KINDS,
  type DashboardYourMoveChip,
  type DashboardYourMoveTarget,
} from '@balo/analytics/events';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { track, CALENDAR_EVENTS, DASHBOARD_EVENTS } from '@/lib/analytics';
import { useViewerClock } from '@/hooks/use-viewer-clock';
import {
  YOUR_MOVE_EMPTY,
  YOUR_MOVE_ERROR,
  YOUR_MOVE_RETRY,
  YOUR_MOVE_RETRYING,
  YOUR_MOVE_TITLE,
  yourMoveCountSentence,
} from '../_lib/your-move-copy';
import {
  YOUR_MOVE_KIND_META,
  type YourMoveCardView,
  type YourMoveData,
  type YourMoveWorkspaceType,
} from '../_lib/your-move-view-types';
import { MoveCard } from './move-card';

const SCROLL_STEP_PX = 314;

interface ChipGroup {
  readonly chip: Exclude<DashboardYourMoveChip, 'all'>;
  readonly label: string;
  readonly count: number;
}

function groupChips(cards: readonly YourMoveCardView[]): ChipGroup[] {
  const groups: { chip: ChipGroup['chip']; label: string; count: number }[] = [];
  for (const card of cards) {
    const { chip, chipLabel } = YOUR_MOVE_KIND_META[card.kind];
    const existing = groups.find((group) => group.chip === chip);
    if (existing) existing.count += 1;
    else groups.push({ chip, label: chipLabel, count: 1 });
  }
  return groups;
}

function FilterChip({
  label,
  count,
  pressed,
  onClick,
}: Readonly<{
  label: string;
  count: number;
  pressed: boolean;
  onClick: () => void;
}>): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'focus-visible:ring-ring inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] font-semibold focus-visible:ring-2 focus-visible:outline-none sm:min-h-8',
        pressed
          ? 'bg-foreground text-background border-foreground'
          : 'bg-card text-foreground border-primary/15'
      )}
    >
      {label} <span className="opacity-65">{count}</span>
    </button>
  );
}

const PANEL_CLASS = 'bg-primary/5 border-primary/15 rounded-[18px] border';

interface YourMoveProps {
  readonly data: YourMoveData;
  readonly workspaceType: YourMoveWorkspaceType;
}

export function YourMove({ data, workspaceType }: Readonly<YourMoveProps>): React.JSX.Element {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();
  const clock = useViewerClock();
  const [overflows, setOverflows] = useState(false);
  const viewedRef = useRef(false);
  const railRef = useRef<HTMLUListElement>(null);
  const [filter, setFilter] = useState<DashboardYourMoveChip>('all');

  const { cards } = data;
  const groups = useMemo(() => groupChips(cards), [cards]);
  const activeFilter = filter === 'all' || groups.some((g) => g.chip === filter) ? filter : 'all';
  const visible = useMemo(
    () =>
      activeFilter === 'all'
        ? cards
        : cards.filter((card) => YOUR_MOVE_KIND_META[card.kind].chip === activeFilter),
    [cards, activeFilter]
  );

  useEffect(() => {
    if (viewedRef.current || data.kind !== 'ready') return;
    viewedRef.current = true;
    track(DASHBOARD_EVENTS.YOUR_MOVE_VIEWED, {
      workspace_type: workspaceType,
      card_count: data.cards.length,
      card_kinds: DASHBOARD_YOUR_MOVE_CARD_KINDS.filter((kind) =>
        data.cards.some((card) => card.kind === kind)
      ),
    });
  }, [data, workspaceType]);

  const railPresent = data.kind === 'ready' && visible.length > 0;
  useEffect(() => {
    const rail = railRef.current;
    if (!railPresent || rail === null) {
      setOverflows(false);
      return;
    }
    const measure = (): void => setOverflows(rail.scrollWidth > rail.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [railPresent, activeFilter, visible.length]);

  const handleFilter = (chip: DashboardYourMoveChip): void => {
    setFilter(chip);
    if (railRef.current) railRef.current.scrollLeft = 0;
    const count =
      chip === 'all'
        ? cards.length
        : cards.filter((card) => YOUR_MOVE_KIND_META[card.kind].chip === chip).length;
    track(DASHBOARD_EVENTS.YOUR_MOVE_FILTERED, {
      workspace_type: workspaceType,
      chip,
      card_count: count,
    });
  };

  const handleNavigate = (
    card: YourMoveCardView,
    position: number,
    target: DashboardYourMoveTarget
  ): void => {
    track(DASHBOARD_EVENTS.YOUR_MOVE_CLICKED, {
      workspace_type: workspaceType,
      target,
      card_kind: card.kind,
      position,
    });
    if (card.kind === 'calendar_reconnect' && target === 'action') {
      track(CALENDAR_EVENTS.CONNECT_CTA_CLICKED, { source: 'dashboard_banner' });
    }
  };

  const scroll = (direction: -1 | 1): void => {
    railRef.current?.scrollBy({ left: direction * SCROLL_STEP_PX, behavior: 'smooth' });
  };

  if (data.kind === 'ready' && cards.length === 0) {
    return (
      <motion.section
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.24, ease: 'easeOut' }}
        aria-label={YOUR_MOVE_EMPTY}
        data-attention="empty"
        className={cn(PANEL_CLASS, 'mb-4 flex items-center gap-3.5 p-4 sm:px-[22px] sm:py-[18px]')}
      >
        <span
          aria-hidden="true"
          className="bg-success/10 text-success-strong inline-flex size-10 shrink-0 items-center justify-center rounded-full"
        >
          <CheckCircle2 className="size-5" />
        </span>
        <span className="text-foreground text-base font-semibold">{YOUR_MOVE_EMPTY}</span>
      </motion.section>
    );
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: 'easeOut' }}
      aria-labelledby="your-move-heading"
      data-attention="rail"
      className={cn(PANEL_CLASS, 'mb-4 pt-[18px] pb-1.5 pl-4 sm:pt-[22px] sm:pb-2.5 sm:pl-[22px]')}
    >
      <div className="flex items-end justify-between gap-3 pr-4 sm:pr-[22px]">
        <div>
          <h2
            id="your-move-heading"
            className="text-foreground text-xl font-semibold tracking-tight sm:text-[22px]"
          >
            {YOUR_MOVE_TITLE}
          </h2>
          {data.kind === 'ready' && (
            <p aria-live="polite" className="text-muted-foreground mt-[3px] text-[13.5px]">
              {yourMoveCountSentence(cards.length)}
            </p>
          )}
        </div>
        {railPresent && overflows && (
          <div className="flex gap-2">
            <button
              type="button"
              aria-label="Scroll back"
              onClick={() => scroll(-1)}
              className="bg-card text-foreground border-primary/15 focus-visible:ring-ring hidden size-9 items-center justify-center rounded-full border focus-visible:ring-2 focus-visible:outline-none sm:flex"
            >
              <ChevronLeft className="size-[18px]" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Scroll forward"
              onClick={() => scroll(1)}
              className="bg-card text-foreground border-primary/15 focus-visible:ring-ring hidden size-9 items-center justify-center rounded-full border focus-visible:ring-2 focus-visible:outline-none sm:flex"
            >
              <ChevronRight className="size-[18px]" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {groups.length > 1 && (
        <fieldset
          aria-label="Filter by type"
          className="my-3.5 flex min-w-0 flex-nowrap gap-2 overflow-x-auto pr-4 sm:flex-wrap sm:overflow-x-visible sm:pr-[22px]"
        >
          <FilterChip
            label="All"
            count={cards.length}
            pressed={activeFilter === 'all'}
            onClick={() => handleFilter('all')}
          />
          {groups.map((group) => (
            <FilterChip
              key={group.chip}
              label={group.label}
              count={group.count}
              pressed={activeFilter === group.chip}
              onClick={() => handleFilter(group.chip)}
            />
          ))}
        </fieldset>
      )}

      {cards.length > 0 && (
        <ul
          ref={railRef}
          aria-label="Waiting on you"
          className={cn(
            'flex snap-x snap-mandatory items-stretch gap-3.5 overflow-x-auto pr-4 pb-3.5 sm:pr-[22px]',
            groups.length > 1 ? 'pt-0' : 'pt-4'
          )}
        >
          {visible.map((card, index) => (
            <MoveCard
              key={card.id}
              card={card}
              featured={activeFilter === 'all' && index === 0}
              clock={clock}
              onNavigate={(target) => handleNavigate(card, index + 1, target)}
            />
          ))}
        </ul>
      )}

      {data.kind === 'error' && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 py-4 pr-4 sm:pr-[22px]"
        >
          <p className="text-muted-foreground text-sm">{YOUR_MOVE_ERROR}</p>
          <Button
            variant="outline"
            size="sm"
            className="min-h-11"
            disabled={retrying}
            onClick={() => startRetry(() => router.refresh())}
          >
            {retrying ? YOUR_MOVE_RETRYING : YOUR_MOVE_RETRY}
          </Button>
        </div>
      )}
    </motion.section>
  );
}
