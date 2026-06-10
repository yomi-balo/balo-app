'use client';

import { useCallback, useState } from 'react';
import { ChevronRight, FileText } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';

interface MobileRequestSheetProps {
  title: string;
  /**
   * SERVER-RENDERED request context (RSC composition): the compact
   * `RequestContext` — and, for the expert lens, the ProposalSlot/EoiEntry
   * stack — stay server components passed through as children.
   */
  children: React.ReactNode;
}

/**
 * Mobile Phase-2 slim request bar (`lg:hidden` applied by the shell): icon +
 * REQUEST eyebrow + truncated title + chevron. Tapping opens a bottom sheet
 * titled "Request details" carrying the server-rendered request context.
 */
export function MobileRequestSheet({
  title,
  children,
}: Readonly<MobileRequestSheetProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const handleOpen = useCallback((): void => setOpen(true), []);

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        aria-label={`Request details: ${title}`}
        className="border-border bg-card hover:bg-muted/40 focus-visible:ring-ring flex min-h-[52px] w-full items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <span className="bg-primary/10 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg">
          <FileText className="text-primary h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-muted-foreground block text-[10.5px] font-semibold tracking-wider uppercase">
            Request
          </span>
          <span className="text-foreground block truncate text-[13px] font-semibold">{title}</span>
        </span>
        <ChevronRight className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          aria-describedby={undefined}
          side="bottom"
          className="max-h-[88vh] gap-0 overflow-hidden rounded-t-2xl"
        >
          <SheetHeader className="border-border border-b pb-3">
            <SheetTitle className="text-sm">Request details</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4 pb-6">{children}</div>
        </SheetContent>
      </Sheet>
    </>
  );
}
