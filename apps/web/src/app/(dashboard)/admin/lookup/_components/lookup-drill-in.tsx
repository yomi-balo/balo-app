'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import type { LookupSelection } from '../_lib/lookup-view';
import { LOOKUP_TYPE_LABEL, resolveOpenTarget } from '../_lib/lookup-view';
import { LookupMoneySection } from './lookup-money-section';
import { LookupTimelineSection } from './lookup-timeline-section';
import { LookupDrillInTabs, panelId, tabId, type LookupDrillInTab } from './lookup-drill-in-tabs';

/**
 * BAL-551/BAL-555 — the Lookup drill-in. Header (type eyebrow, title, Open-or-not) plus a
 * TAB SHELL: a `role="tablist"` bar rendered ONLY when there are two or more tabs (credit
 * sessions get Timeline + Money); every other type renders the Timeline as a single labelled
 * SECTION with no tab bar at all (C2 — a one-tab tab bar is still a defect). NOTHING here
 * mutates: no forms, no `action=`, no write-shaped button.
 *
 * ⚠⚠ BAL-555 fix round F2 — VISITED TABS STAY MOUNTED, HIDDEN RATHER THAN UNMOUNTED. The two
 * panels previously conditionally rendered ONE AT A TIME under a `key={tab}`-remounting
 * wrapper, so switching Timeline → Money → Timeline discarded every "Load earlier" page the
 * user had already loaded and silently refetched page 1. `visitedTabs` tracks which panels
 * have ever been selected; a visited panel's `<div role="tabpanel">` stays in the tree forever
 * after, toggled with the native `hidden` attribute (never `style.display`) so the ARIA
 * tabs wiring (`aria-labelledby`, and testing-library's/AT's accessibility-tree exclusion of
 * `hidden` elements) keeps working unchanged. Only the two-tab (credit session) case is
 * affected — a single-tab type never unmounts anything to begin with.
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
  if (selection.type === 'engagement') {
    if (selection.engagementType === 'case') {
      // pending-MJ — BAL-555 C1: `/cases/[engagementId]` has NO ADMIN LENS at all.
      return "There's no staff page for a case yet — what Balo has is above.";
    }
    if (selection.via === 'recent') {
      // pending-MJ — a Recent entry saved before BAL-555 shipped carries no engagementType.
      return 'Recent links can go stale — search for this engagement again to open its current page.';
    }
  }
  // pending-MJ
  return `There's no ${LOOKUP_TYPE_LABEL[selection.type].toLowerCase()} page yet — what Balo has is above.`;
}

interface LookupDrillInProps {
  readonly selection: LookupSelection;
  readonly onTabSelect: (tab: LookupDrillInTab) => void;
}

export function LookupDrillIn({
  selection,
  onTabSelect,
}: Readonly<LookupDrillInProps>): React.JSX.Element {
  const target = resolveOpenTarget(selection);
  const [tab, setTab] = useState<LookupDrillInTab>('timeline');
  // BAL-555 fix round F2 — the initial tab is always "visited" (it fetches immediately on
  // mount today, and this preserves that), `money` joins only once the user actually selects
  // it, and NEVER leaves once added — that's what keeps its "Load earlier" paging alive across
  // a switch back to Timeline and forth again.
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<LookupDrillInTab>>(
    () => new Set<LookupDrillInTab>(['timeline'])
  );

  const tabs: readonly { readonly key: LookupDrillInTab; readonly label: string }[] =
    selection.type === 'credit_session'
      ? [
          { key: 'timeline', label: 'Timeline' },
          { key: 'money', label: 'Money' },
        ]
      : [{ key: 'timeline', label: 'Timeline' }];

  function selectTab(next: LookupDrillInTab): void {
    setTab(next);
    setVisitedTabs((current) => (current.has(next) ? current : new Set(current).add(next)));
    onTabSelect(next);
  }

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

        <div className="mt-3">
          {tabs.length >= 2 ? (
            <>
              <LookupDrillInTabs tabs={tabs} active={tab} onSelect={selectTab} />
              <div
                role="tabpanel"
                id={panelId('timeline')}
                aria-labelledby={tabId('timeline')}
                hidden={tab !== 'timeline'}
                className="mt-3"
              >
                <LookupTimelineSection
                  entityType={selection.type}
                  entityId={selection.id}
                  labelled={false}
                />
              </div>
              {selection.type === 'credit_session' && visitedTabs.has('money') && (
                <div
                  role="tabpanel"
                  id={panelId('money')}
                  aria-labelledby={tabId('money')}
                  hidden={tab !== 'money'}
                  className="mt-3"
                >
                  <LookupMoneySection sessionId={selection.id} labelled={false} />
                </div>
              )}
            </>
          ) : (
            <LookupTimelineSection entityType={selection.type} entityId={selection.id} labelled />
          )}
        </div>
      </div>
    </div>
  );
}
