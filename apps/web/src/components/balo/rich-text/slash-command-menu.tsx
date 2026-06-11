'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react';
import { cn } from '@/lib/utils';
import type { SlashCommandItem } from './slash-command';

export interface SlashCommandMenuProps {
  /** The candidate commands for the current `/` query (already filtered). */
  items: ReadonlyArray<SlashCommandItem>;
  /** Invoked with the chosen item when the user selects one. */
  onSelect: (item: SlashCommandItem) => void;
}

/**
 * Imperative handle the `@tiptap/suggestion` render hook delegates keyboard
 * events to. Returns `true` when the menu consumed the key (so Tiptap stops
 * propagation), `false` otherwise.
 */
export interface SlashCommandMenuHandle {
  onKeyDown: (event: KeyboardEvent) => boolean;
}

/**
 * The rendered `/` slash-command popover for the `full` overview editor. A small
 * keyboard-navigable list (Up/Down to move, Enter/Tab to choose, Escape handled
 * by Tiptap). Mounted by the suggestion `render()` hook via `ReactRenderer` and
 * positioned by the editor; this component only owns the highlighted index and
 * the visual list. Dark-mode semantic tokens only.
 */
export const SlashCommandMenu = forwardRef<SlashCommandMenuHandle, Readonly<SlashCommandMenuProps>>(
  function SlashCommandMenu({ items, onSelect }, ref): React.JSX.Element {
    const [activeIndex, setActiveIndex] = useState(0);

    // Reset the highlight whenever the candidate set changes (new query).
    useEffect(() => {
      setActiveIndex(0);
    }, [items]);

    const select = useCallback(
      (index: number) => {
        const item = items[index];
        if (item === undefined) return;
        onSelect(item);
      },
      [items, onSelect]
    );

    useImperativeHandle(
      ref,
      () => ({
        onKeyDown: (event: KeyboardEvent): boolean => {
          if (items.length === 0) return false;
          if (event.key === 'ArrowUp') {
            setActiveIndex((i) => (i + items.length - 1) % items.length);
            return true;
          }
          if (event.key === 'ArrowDown') {
            setActiveIndex((i) => (i + 1) % items.length);
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            setActiveIndex((current) => {
              select(current);
              return current;
            });
            return true;
          }
          return false;
        },
      }),
      [items, select]
    );

    if (items.length === 0) {
      return (
        <div className="border-border bg-popover text-muted-foreground rounded-lg border px-3 py-2 text-xs shadow-md">
          No matches
        </div>
      );
    }

    return (
      <div
        role="listbox"
        aria-label="Slash commands"
        className="border-border bg-popover w-56 overflow-hidden rounded-lg border p-1 shadow-md"
      >
        {items.map((item, index) => {
          const Icon = item.icon;
          const active = index === activeIndex;
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={active}
              // Keep the editor selection while interacting with the menu.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => select(index)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                active
                  ? 'bg-primary/10 text-primary'
                  : 'text-foreground hover:bg-muted hover:text-foreground'
              )}
            >
              <span
                className={cn(
                  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border',
                  active ? 'border-primary/30 bg-primary/10' : 'border-border bg-muted/40'
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{item.title}</span>
                <span className="text-muted-foreground truncate text-xs">{item.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    );
  }
);
