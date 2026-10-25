'use client';

import { useCallback, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { BaloCard } from '@/components/balo/card/balo-card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ChangeOrderItemView } from '@/lib/engagement/change-order-view';
import { ChangeOrderLines } from './change-order-lines';
import { ChangeOrderPriceEffect } from './change-order-price-effect';
import { TonePill, VIEW_TONE } from './change-order-tone';

interface ChangeOrderHistoryProps {
  /** Settled and in-flight orders for this viewer, newest first. */
  history: ChangeOrderItemView[];
}

interface HistoryRowProps {
  item: ChangeOrderItemView;
  open: boolean;
  onToggle: (id: string) => void;
}

function hasDetail(item: ChangeOrderItemView): boolean {
  return (
    item.lines.length > 0 ||
    item.declineText !== null ||
    item.answerText !== null ||
    item.priceEffect !== null
  );
}

function HistoryRow({ item, open, onToggle }: Readonly<HistoryRowProps>): React.JSX.Element {
  const toggle = useCallback((): void => onToggle(item.id), [item.id, onToggle]);
  const detailId = `change-order-detail-${item.id}`;
  const summaryText = item.summary ?? item.requestNote;
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <TonePill tone={VIEW_TONE[item.pill.tone]}>{item.pill.label}</TonePill>
            {item.deltaChip !== null && (
              <span className="text-muted-foreground text-sm">{item.deltaChip}</span>
            )}
          </div>
          {summaryText !== null && (
            <p className="text-foreground mt-1.5 text-sm leading-relaxed">
              {item.summary === null ? `“${summaryText}”` : summaryText}
            </p>
          )}
          <p className="text-muted-foreground mt-1 text-xs">{item.datesLabel}</p>
        </div>
        {hasDetail(item) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={toggle}
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', open && 'rotate-180')}
              aria-hidden
            />
            {open ? 'Hide' : 'Details'}
          </Button>
        )}
      </div>
      {open && (
        <div id={detailId} className="mt-2">
          {item.answerText !== null && (
            <p className="text-muted-foreground text-sm">{item.answerText}</p>
          )}
          {item.declineText !== null && (
            <p className="text-muted-foreground text-sm">{item.declineText}</p>
          )}
          {item.lines.length > 0 && <ChangeOrderLines lines={item.lines} />}
          {item.priceEffect !== null && <ChangeOrderPriceEffect effect={item.priceEffect} />}
        </div>
      )}
    </li>
  );
}

/**
 * "Changes to this project": every order the viewer may see, newest first, each expandable to
 * its lines and settled price effect. Hidden when there is nothing to list: it is purely
 * retrospective data the viewer cannot act on or populate from here.
 */
export function ChangeOrderHistory({
  history,
}: Readonly<ChangeOrderHistoryProps>): React.JSX.Element | null {
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((id: string): void => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  if (history.length === 0) return null;

  return (
    <BaloCard as="section" aria-label="Changes to this project" className="p-6">
      <h2 className="text-foreground text-sm font-semibold">Changes to this project</h2>
      <ul className="divide-border mt-4 divide-y">
        {history.map((item) => (
          <HistoryRow key={item.id} item={item} open={openIds.has(item.id)} onToggle={toggle} />
        ))}
      </ul>
    </BaloCard>
  );
}
