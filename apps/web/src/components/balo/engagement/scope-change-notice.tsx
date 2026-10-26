'use client';

import Link from 'next/link';
import { Info, X } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Where "Propose a change" leads: the composer link, the reason it is unavailable (a change is
 * already with the client), or `null` when the viewer has no composer entry.
 */
export type ScopeChangeCta = { href: string } | { disabledReason: string } | null;

/** The "Propose a change" action (or the reason it is unavailable) for a scope-change message. */
export function ScopeChangeCtaAction({
  cta,
}: Readonly<{ cta: ScopeChangeCta }>): React.JSX.Element | null {
  if (cta === null) return null;
  if ('disabledReason' in cta) {
    return <span className="text-muted-foreground text-xs">{cta.disabledReason}</span>;
  }
  return (
    <Button size="sm" asChild className="min-h-11">
      <Link href={cta.href}>Propose a change</Link>
    </Button>
  );
}

interface ScopeChangeNoticeProps {
  message: string;
  cta: ScopeChangeCta;
  onDismiss: () => void;
}

/**
 * Explains in one line why a plain milestone write needs the client's approval, with the way
 * into the change-order composer. Shown in place of an error toast after a refused write.
 */
export function ScopeChangeNotice({
  message,
  cta,
  onDismiss,
}: Readonly<ScopeChangeNoticeProps>): React.JSX.Element {
  return (
    <div
      role="status"
      className="border-info/25 bg-info/10 mt-4 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3"
    >
      <Info className="text-info size-4 shrink-0" aria-hidden />
      <p className="text-foreground min-w-48 flex-1 text-sm leading-relaxed">{message}</p>
      <ScopeChangeCtaAction cta={cta} />
      <Button
        size="icon"
        variant="ghost"
        className="text-muted-foreground size-11"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <X className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
