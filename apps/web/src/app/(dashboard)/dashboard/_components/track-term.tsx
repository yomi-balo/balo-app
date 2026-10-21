'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const HOVER_OPEN_DELAY_MS = 300;

const TERM_TRIGGER_CLASS =
  'cursor-help rounded-sm underline decoration-dotted decoration-muted-foreground/60 underline-offset-[3px] focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none';

interface TrackTermPopoverProps {
  readonly term: string;
  readonly explanation: string;
  readonly align: 'start' | 'end';
  readonly onOpened: () => void;
}

/** Desktop trigger: the term itself, with its one sentence in a popover. */
export function TrackTermPopover({
  term,
  explanation,
  align,
  onOpened,
}: Readonly<TrackTermPopoverProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const openedByHover = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const descId = useId();

  const clearHoverTimer = useCallback((): void => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  useEffect(() => clearHoverTimer, [clearHoverTimer]);

  const show = useCallback(
    (byHover: boolean): void => {
      openedByHover.current = byHover;
      setOpen(true);
      onOpened();
    },
    [onOpened]
  );

  const handleClick = useCallback(
    (event: React.MouseEvent): void => {
      event.preventDefault();
      clearHoverTimer();
      if (open && openedByHover.current) {
        openedByHover.current = false;
        return;
      }
      if (open) {
        setOpen(false);
        return;
      }
      show(false);
    },
    [open, show, clearHoverTimer]
  );

  const handlePointerEnter = useCallback(
    (event: React.PointerEvent): void => {
      if (event.pointerType !== 'mouse' || open) return;
      clearHoverTimer();
      hoverTimer.current = setTimeout(() => show(true), HOVER_OPEN_DELAY_MS);
    },
    [open, show, clearHoverTimer]
  );

  const handlePointerLeave = useCallback(
    (event: React.PointerEvent): void => {
      if (event.pointerType !== 'mouse') return;
      clearHoverTimer();
      if (open && openedByHover.current) {
        openedByHover.current = false;
        setOpen(false);
      }
    },
    [open, clearHoverTimer]
  );

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (next) return;
      clearHoverTimer();
      openedByHover.current = false;
      setOpen(false);
    },
    [clearHoverTimer]
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-describedby={open ? descId : undefined}
          onClick={handleClick}
          onPointerEnter={handlePointerEnter}
          onPointerLeave={handlePointerLeave}
          className={TERM_TRIGGER_CLASS}
        >
          {term}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align={align}
        sideOffset={6}
        collisionPadding={16}
        aria-label={term}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="bg-card border-border text-muted-foreground w-60 max-w-[calc(100vw-32px)] rounded-[10px] px-3 py-2.5 text-[12.5px] leading-[1.45] font-normal shadow-lg"
      >
        <span className="text-foreground mb-0.5 block text-[13px] font-semibold">{term}</span>
        <span id={descId}>{explanation}</span>
      </PopoverContent>
    </Popover>
  );
}

interface TrackTermToggleProps {
  readonly term: string;
  readonly open: boolean;
  readonly controls: string;
  readonly onToggle: () => void;
}

/** Mobile trigger: the term itself, toggling an inline sentence rendered by `TrackTermPanel`. */
export function TrackTermToggle({
  term,
  open,
  controls,
  onToggle,
}: Readonly<TrackTermToggleProps>): React.JSX.Element {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      onClick={onToggle}
      className={cn(
        TERM_TRIGGER_CLASS,
        '-my-3 inline-flex min-h-11 items-center',
        open && 'text-primary decoration-primary'
      )}
    >
      {term}
    </button>
  );
}

interface TrackTermPanelProps {
  readonly id: string;
  readonly title?: string;
  readonly children: React.ReactNode;
}

/** The inline sentence box a `TrackTermToggle` opens. */
export function TrackTermPanel({
  id,
  title,
  children,
}: Readonly<TrackTermPanelProps>): React.JSX.Element {
  return (
    <div
      id={id}
      className="bg-background border-border text-muted-foreground mt-2 rounded-lg border px-2.5 py-2 text-[12.5px] leading-[1.45]"
    >
      {title !== undefined && <span className="text-foreground block font-semibold">{title}</span>}
      {children}
    </div>
  );
}
