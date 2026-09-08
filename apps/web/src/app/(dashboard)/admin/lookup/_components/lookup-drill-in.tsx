'use client';

import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import type { LookupSelection } from '../_lib/lookup-view';
import { LOOKUP_TYPE_LABEL, resolveOpenTarget } from '../_lib/lookup-view';
import { LookupMoneySection } from './lookup-money-section';

/**
 * BAL-551 — the Lookup drill-in. Header (type eyebrow, title, Open-or-not) plus, for a
 * `credit_session` only, the Money section. NOTHING here mutates: no forms, no `action=`, no
 * write-shaped button.
 */

function noDestinationCopy(selection: LookupSelection): string {
  if (selection.type === 'expert' && selection.via === 'recent') {
    // pending-MJ — BAL-551 fix round F12: Recent never carries a live username (it could go
    // stale if this expert renamed since being saved to Recent), so re-search to get a link
    // that is guaranteed current, even for an expert whose profile is public right now.
    return 'Recent links can go stale if a username changes — search for this expert again to open their current profile.';
  }
  if (selection.type === 'expert') {
    // pending-MJ
    return "This profile isn't public yet, so there's no page to open.";
  }
  if (selection.type === 'credit_session') {
    // pending-MJ
    return "The receipt is the client's own view — there's no staff page for a session yet.";
  }
  // pending-MJ
  return `There's no ${LOOKUP_TYPE_LABEL[selection.type].toLowerCase()} page yet — what Balo has is above.`;
}

interface LookupDrillInProps {
  readonly selection: LookupSelection;
}

export function LookupDrillIn({ selection }: Readonly<LookupDrillInProps>): React.JSX.Element {
  const target = resolveOpenTarget(selection);

  return (
    <div className="border-border bg-card overflow-hidden rounded-2xl border">
      <div className="border-border/60 border-b p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-muted-foreground text-[11px] font-bold tracking-wide uppercase">
              {LOOKUP_TYPE_LABEL[selection.type]}
            </p>
            <p className="text-foreground mt-0.5 text-[14.5px] font-semibold">{selection.title}</p>
          </div>
          {target !== null && (
            <Link
              href={target.href}
              className="text-primary focus-visible:ring-ring inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded px-1 text-xs font-semibold hover:underline focus-visible:ring-2 focus-visible:outline-none"
            >
              <ExternalLink className="size-3.5" aria-hidden="true" />
              {target.label}
            </Link>
          )}
        </div>
        {target === null && (
          <p className="text-muted-foreground mt-2 text-xs">{noDestinationCopy(selection)}</p>
        )}
      </div>
      <div className="p-4">
        <p className="text-muted-foreground text-xs leading-relaxed">{selection.sub}</p>
        {selection.type === 'credit_session' && (
          <div className="mt-3">
            <LookupMoneySection sessionId={selection.id} />
          </div>
        )}
      </div>
    </div>
  );
}
