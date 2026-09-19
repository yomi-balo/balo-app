'use client';

import * as React from 'react';
import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function ScrollArea({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      /*
       * ⚠ `overflow-hidden` here and `max-h-[inherit]` on the Viewport below are a pair; neither
       * works alone. Every call site caps this component with `max-h-*` and no definite height,
       * and the Viewport's `size-full` cannot resolve a percentage height against that — it
       * falls back to `auto`, grows to full content height, never scrolls, and spills out of the
       * capped Root, where (the Root being positioned) it paints over and intercepts clicks on
       * whatever follows. `overflow-hidden` alone stops the interception but leaves the tail of
       * the list unreachable.
       *
       * ⚠⚠ CONSEQUENCE FOR CALL SITES: CAP THIS WITH `max-h-*` AND NOTHING ELSE. `inherit` takes
       * the Root's max-height verbatim, while `box-sizing: border-box` shrinks the Root's own
       * CONTENT box by any padding or border — so `<ScrollArea className="max-h-[400px] p-4">`
       * gives the Viewport a 400px cap inside a 368px content box, and `overflow-hidden` clips
       * the last 32px of the list where nothing can scroll to it. Put the padding on the child.
       */
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className="focus-visible:ring-ring/50 size-full max-h-[inherit] rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-[3px] focus-visible:outline-1"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        'flex touch-none p-px transition-colors select-none',
        orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent',
        orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent',
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="bg-border relative flex-1 rounded-full"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  );
}

export { ScrollArea, ScrollBar };
