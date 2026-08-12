import type { ReactNode } from 'react';
import { Reveal } from '@/components/balo/engagement/reveal';
import { ActionItemsPanel } from '@/components/balo/engagement/action-items-panel';
import type { RecapView } from '@/lib/meetings/recap-view-types';
import { RecapHeader } from './recap-header';
import { SummarySection } from './summary-section';
import { TranscriptSection } from './transcript-section';
import { PartyCard } from './party-card';
import { FilesCard } from './files-card';
import { NotHeldPanel } from './not-held-panel';
import { UnlessDismissed } from './resolve-dismissal';

/**
 * The action-items panel view ONLY when it will actually render something.
 *
 * ⚠ THE SAME EMPTY-WRAPPER RULE THE SLOTS OBEY, AND IT BITES HARDEST HERE. `ActionItemsPanel`
 * itself returns `null` for a READ-ONLY, ITEM-LESS list (purely retrospective — nothing to act
 * on), and EVERY recap is read-only today, so the UNIVERSAL zero-action-item meeting hit it: a
 * `Reveal` wrapping a null child is still a grid CHILD, i.e. a dead 16-24px gap between the
 * summary and the transcript. This mirrors the panel's own rule, and `recap-layout.test.tsx`
 * renders the zero-action-item composition so the two cannot drift apart silently.
 */
function visibleActionItems(view: RecapView): RecapView['actionItems'] {
  const panel = view.actionItems;
  if (panel === null) return null;
  if (panel.canWrite || panel.items.length > 0) return panel;
  return null;
}

/**
 * BAL-388 — the SHARED recap shell: everything BOTH lenses render, plus two neutral SLOTS.
 *
 * ⚠⚠ THE SLOTS ARE WHY THIS FILE EXISTS. The two compositions differ only by §R4 and §R9, and
 * re-spelling the other nine regions in a second file is exactly the shape SonarCloud >3%
 * new-code duplication gate exists to catch. This module names NEITHER client-only component:
 * it takes `ReactNode`s. `client-recap.tsx` fills them; `expert-recap.tsx` does not, and never
 * imports them — so the expert lens is structurally incapable of mounting the resolve prompt.
 * A source scan over EVERY file in this directory pins that.
 *
 * ⚠⚠ BOTH SLOTS SIT INSIDE `UnlessDismissed`, WRAPPER AND ALL. Dismissing the R4 banner is a
 * SERVER mutation that clears the request columns, so the next render legitimately reports
 * `variant: 'offered'` and the client composition fills the §R9 slot — re-asking, in the same
 * breath, the question the client just declined. The gate is lens-NEUTRAL (no provider ⇒ always
 * renders, which is exactly the expert lens and every isolated test), and it wraps the `Reveal`
 * rather than living inside the prompt so no empty wrapper is left behind.
 *
 * ⚠⚠ THE TRANSCRIPT IS GATED ON `!collapsed`, AND THE GATE BELONGS HERE. `resolveArtifacts`
 * COLLAPSES the summary and transcript into ONE card when neither has anything to show, and
 * `SummarySection` renders that card — but a transcript rendered unconditionally beside it puts
 * TWO contradictory absence statements on the page ("No summary or transcript for this one",
 * then a Transcript card saying "No transcript for this one"). That is the exact "two sad
 * stacked cards" reading the collapse rule exists to prevent, and it is the COMMON case today
 * because the pipeline has no production enqueuer. The state was computed; it just was not
 * composed.
 *
 * ⚠⚠ MOBILE ORDER IS DELIBERATELY NOT DESKTOP ORDER, AND THE COLUMN WRAPPERS ARE
 * `display: contents` BELOW `lg` TO MAKE IT WORK. Order only resolves between SIBLING grid
 * items; with the wrappers left as flex containers the transcript `order-last` was scoped to
 * the main column, where the transcript is already last — a no-op, which is how the longest
 * region ended up sitting between the action items and the only forward action at 375px.
 * `contents` dissolves both wrappers on mobile so all six regions become real children of the
 * one-column grid and the `order-*` ladder actually applies; `lg:flex` restores the two columns.
 * DOM order stays DESKTOP order deliberately — two independent-height columns cannot be
 * expressed with a single DOM sequence, and explicit row placement would leave a dead gap above
 * the transcript whenever the rail outgrows a short summary. CSS `order` is the mechanism;
 * `recap-layout.test.tsx` asserts BOTH the DOM sequence and that the transcript wrapper is a
 * genuine grid CHILD (its parent carries `contents`), which is the half that was broken.
 *
 * ⚠ THE DELAY LADDER INTERLEAVES THE RAIL (0.12 / 0.17 / 0.22) rather than sequencing it after
 * the main column, so the two columns read as ONE cascade instead of a relay. `Reveal` already
 * returns a plain wrapper under `prefers-reduced-motion`.
 */
export function RecapLayout({
  view,
  banner,
  wrapUp,
}: Readonly<{ view: RecapView; banner?: ReactNode; wrapUp?: ReactNode }>): React.JSX.Element {
  const notHeld = view.notHeld;
  const showTranscript = !view.artifacts.collapsed;
  const actionItems = visibleActionItems(view);

  return (
    <div className="from-background to-muted/30 min-h-full bg-gradient-to-b">
      <div className="mx-auto w-full max-w-[1060px] px-4 py-8 sm:px-6 lg:px-8">
        <Reveal>
          <RecapHeader header={view.header} money={view.money} />
        </Reveal>

        {banner !== undefined && (
          <UnlessDismissed>
            <Reveal delay={0.05} className="mt-4 block">
              {banner}
            </Reveal>
          </UnlessDismissed>
        )}

        <div className="mt-6 grid items-start gap-4 lg:grid-cols-[minmax(0,2.4fr)_minmax(0,1fr)] lg:gap-6">
          <div className="contents lg:flex lg:flex-col lg:gap-6">
            {notHeld === null ? (
              <>
                <Reveal delay={0.1} className="order-1 lg:order-none">
                  <SummarySection artifacts={view.artifacts} />
                </Reveal>
                {actionItems !== null && (
                  <Reveal delay={0.15} className="order-2 lg:order-none">
                    <ActionItemsPanel view={actionItems} />
                  </Reveal>
                )}
                {showTranscript && (
                  <Reveal delay={0.2} className="order-last lg:order-none">
                    <TranscriptSection
                      meetingId={view.meetingId}
                      transcript={view.artifacts.transcript}
                    />
                  </Reveal>
                )}
              </>
            ) : (
              <Reveal delay={0.1} className="order-1 lg:order-none">
                <NotHeldPanel notHeld={notHeld} />
              </Reveal>
            )}
          </div>

          <div className="contents lg:flex lg:flex-col lg:gap-6">
            <Reveal delay={0.12} className="order-3 lg:order-none">
              <PartyCard party={view.party} lens={view.lens} />
            </Reveal>
            {wrapUp !== undefined && (
              <UnlessDismissed>
                <Reveal delay={0.17} className="order-4 lg:order-none">
                  {wrapUp}
                </Reveal>
              </UnlessDismissed>
            )}
            <Reveal delay={0.22} className="order-5 lg:order-none">
              <FilesCard meetingId={view.meetingId} files={view.files} />
            </Reveal>
          </div>
        </div>
      </div>
    </div>
  );
}
