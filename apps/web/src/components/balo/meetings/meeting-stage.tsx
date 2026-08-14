'use client';

import { MonitorUp } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import { galleryGridClass, galleryScrollsOnMobile } from '@/lib/meetings/gallery-grid';
import type { OrderedTiles, TileCandidate } from '@/lib/meetings/order-tiles';
import type { StageKind } from '@/lib/meetings/resolve-stage';
import { OverflowTile, ParticipantTile } from './participant-tile';

/**
 * BAL-435 — the three video layouts, plus the thin kind→layout switch.
 *
 * ⚠ THE **RESOLVER** LIVES IN `lib/meetings/resolve-stage.ts`, NOT HERE. Everything in that
 * module decides WHAT STATE we are in; everything here decides what that state LOOKS LIKE. The
 * split is what keeps `sonarjs/cognitive-complexity` under 15 — the same seam `JoinPhaseContent`
 * was extracted from `JoinControl` along.
 *
 * ⚠ EVERY TILE IS KEYED BY ITS DAILY **SESSION ID**, never by an array index (S6479).
 *
 * ── ⚠⚠ THE GALLERY MUST **SHRINK TO FIT**, AND THAT IS A CORRECTNESS RULE, NOT A PREFERENCE ──
 *
 * The grid lives in a FIXED-HEIGHT, `overflow-hidden` stage that deliberately does not scroll on
 * desktop. With `auto-rows-min` + aspect-ratio tiles, row height is derived from column WIDTH, so
 * at 3, 4, 7, 8 and 9 participants the rows totalled more than the well: `content-center` split
 * the excess and sliced ~80px off the top AND bottom of every face. `auto-rows-fr` plus `h-full`
 * cells makes the rows share the height they actually have — the tile gets wider than 16:10 and
 * `object-cover` handles that, which is the trade every call UI makes.
 *
 * ⚠ THE ONE EXCEPTION IS THE MOBILE SCROLLING GALLERY (N ≥ 7), where fixed-aspect rows are the
 * POINT — the column scrolls with snap points. So the aspect is kept below `sm` and released
 * above it, on the CELL, in CSS.
 */

export interface StageTilesProps {
  readonly tiles: OrderedTiles;
  readonly activeSpeakerId: string | null;
}

function isSpeaking(candidate: TileCandidate, activeSpeakerId: string | null): boolean {
  return candidate.sessionId === activeSpeakerId;
}

/** §13.2 — a tile arriving or leaving. ⚠ Reduced motion: no transform, no travel, no stagger. */
function tileMotion(reduceMotion: boolean, index: number): Record<string, unknown> {
  if (reduceMotion) {
    // ⚠ THE CHANGE IS CARRIED BY THE FRAME'S `aria-live` REGION INSTEAD (§13.3), which is why
    // that region is not optional polish.
    return { initial: false };
  }
  return {
    layout: true,
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0 },
    // ⚠ 80ms STAGGER, CAPPED AT SIX. A ten-tile cascade runs 800ms and reads as slow.
    transition: { duration: 0.3, delay: Math.min(index, 5) * 0.08, ease: 'easeOut' },
  };
}

/** 1 remote + self as a picture-in-picture. */
export function SpotlightLayout({
  tiles,
  activeSpeakerId,
  selfIsPrimary = false,
  onSwapSelf,
}: Readonly<
  StageTilesProps & { selfIsPrimary?: boolean; onSwapSelf?: () => void }
>): React.JSX.Element {
  const remote = tiles.visible.find((tile) => !tile.isLocal);
  const self = tiles.visible.find((tile) => tile.isLocal);

  if (remote === undefined) {
    // ⚠ Defensive: `resolveStageKind` only chooses spotlight at remoteCount === 1, so this is
    // reachable only for one frame during a leave. Render self rather than nothing.
    return (
      <div className="h-full w-full">
        {self === undefined ? null : (
          <ParticipantTile sessionId={self.sessionId} isLocal big isSpeaking={false} />
        )}
      </div>
    );
  }

  // ⚠ THE SWAP IS REAL STATE, OWNED BY THE FRAME. The button used to be inert — a focusable
  // control in the tab order that did nothing, offered to a screen-reader user as an action.
  const primary = selfIsPrimary && self !== undefined ? self : remote;
  const pip = primary === remote ? self : remote;

  return (
    <div className="relative h-full w-full">
      <ParticipantTile
        sessionId={primary.sessionId}
        isLocal={primary.isLocal}
        big
        isSpeaking={isSpeaking(primary, activeSpeakerId)}
      />
      {pip === undefined ? null : (
        <div className="absolute right-3 bottom-3 w-[112px] lg:right-4 lg:bottom-4 lg:w-[190px]">
          {/*
            ⚠ TAP-TO-SWAP ON TOUCH, NOT DRAG. Dragging competes with scrolling on a phone, and a
            static PIP covering the thing being discussed is the single most common complaint
            about every 1:1 call UI — so the PIP is always MOVEABLE, just not always by drag.
          */}
          <button
            type="button"
            onClick={onSwapSelf}
            aria-label="Swap the small and large video"
            className="focus-visible:ring-ring block w-full rounded-xl shadow-lg focus-visible:ring-2 focus-visible:outline-none"
          >
            <ParticipantTile sessionId={pip.sessionId} isLocal={pip.isLocal} isSpeaking={false} />
          </button>
        </div>
      )}
    </div>
  );
}

/** 2–9 remotes, plus self last, plus an overflow cell above the cap. */
export function GalleryLayout({
  tiles,
  activeSpeakerId,
}: Readonly<StageTilesProps>): React.JSX.Element {
  const reduceMotion = useReducedMotion() === true;
  const hasOverflow = tiles.overflow.length > 0;
  const cellCount = tiles.visible.length + (hasOverflow ? 1 : 0);
  const scrolls = galleryScrollsOnMobile(cellCount);
  // ⚠ SEE THE MODULE DOCBLOCK. `fr` rows are what stop the fixed-height stage clipping faces;
  // the mobile scrolling gallery keeps aspect rows below `sm` because there the column scrolls.
  const cellClasses = scrolls ? 'aspect-[16/10] sm:aspect-auto sm:h-full' : 'h-full';

  return (
    <div
      className={cn(
        'grid h-full w-full content-center gap-3',
        scrolls ? 'auto-rows-min sm:auto-rows-fr' : 'auto-rows-fr',
        galleryGridClass(cellCount),
        // ⚠ MOBILE ONLY, AND ONLY FROM SEVEN. The active speaker is sorted into the first row, so
        // scrolling is optional and never required.
        scrolls ? 'snap-y snap-mandatory overflow-y-auto sm:overflow-visible' : ''
      )}
    >
      <AnimatePresence initial={false}>
        {tiles.visible.map((tile, index) => (
          <motion.div
            key={tile.sessionId}
            className={cn('min-h-0 snap-start', cellClasses)}
            {...tileMotion(reduceMotion, index)}
          >
            <ParticipantTile
              sessionId={tile.sessionId}
              isLocal={tile.isLocal}
              fill
              isSpeaking={isSpeaking(tile, activeSpeakerId)}
            />
          </motion.div>
        ))}
      </AnimatePresence>
      {hasOverflow ? (
        // ⚠ A FIXED LITERAL KEY — never an index, and never a value derived from one.
        <div key="meeting-overflow-tile" className={cn('min-h-0 snap-start', cellClasses)}>
          <OverflowTile
            // ⚠ SESSION IDS, RESOLVED TO **NAMES** INSIDE THE TILE. Passing them where names
            // belonged rendered initials derived from a UUID into visible markup.
            sessionIds={tiles.overflow.map((tile) => tile.sessionId)}
            hiddenCount={tiles.overflow.length}
          />
        </div>
      ) : null}
    </div>
  );
}

/** Shared content is primary; a presenter strip sits beside it on desktop only. */
export function ScreenShareLayout({
  tiles,
  activeSpeakerId,
  screenSessionId,
}: Readonly<StageTilesProps & { screenSessionId: string | null }>): React.JSX.Element {
  return (
    <div className="flex h-full w-full gap-3">
      <div className="bg-background border-border relative flex min-w-0 flex-1 items-center justify-center overflow-hidden rounded-2xl border">
        {screenSessionId === null ? (
          <span className="text-muted-foreground flex flex-col items-center gap-2 text-sm">
            <MonitorUp className="h-[30px] w-[30px]" aria-hidden="true" />
            Waiting for the shared screen
          </span>
        ) : (
          /* ⚠ THE SCREEN TRACK, NOT THE CAMERA ONE — and never mirrored. */
          <ParticipantTile
            sessionId={screenSessionId}
            isLocal={false}
            big
            trackType="screenVideo"
            isSpeaking={false}
          />
        )}
        <span className="bg-primary/15 text-primary absolute top-3 left-3 rounded-lg px-2.5 py-1 text-xs font-medium">
          Screen share
        </span>
      </div>
      {/*
        ⚠ MOBILE DROPS THE STRIP ENTIRELY. At 375px the shared screen IS the call; a column of
        168px tiles beside it leaves neither readable.
      */}
      <div className="hidden w-[168px] shrink-0 flex-col gap-3 overflow-y-auto lg:flex">
        {tiles.visible.map((tile) => (
          <ParticipantTile
            key={tile.sessionId}
            sessionId={tile.sessionId}
            isLocal={tile.isLocal}
            isSpeaking={isSpeaking(tile, activeSpeakerId)}
          />
        ))}
      </div>
    </div>
  );
}

export interface StageContentProps extends StageTilesProps {
  readonly kind: Extract<StageKind, 'spotlight' | 'gallery' | 'screenshare'>;
  readonly screenSessionId: string | null;
  readonly selfIsPrimary?: boolean;
  readonly onSwapSelf?: () => void;
}

/** ⚠ A THIN SWITCH. Adding logic here is what pushes the file back over the complexity limit. */
export function StageContent({
  kind,
  tiles,
  activeSpeakerId,
  screenSessionId,
  selfIsPrimary,
  onSwapSelf,
}: Readonly<StageContentProps>): React.JSX.Element {
  if (kind === 'screenshare') {
    return (
      <ScreenShareLayout
        tiles={tiles}
        activeSpeakerId={activeSpeakerId}
        screenSessionId={screenSessionId}
      />
    );
  }
  if (kind === 'spotlight') {
    return (
      <SpotlightLayout
        tiles={tiles}
        activeSpeakerId={activeSpeakerId}
        selfIsPrimary={selfIsPrimary}
        onSwapSelf={onSwapSelf}
      />
    );
  }
  return <GalleryLayout tiles={tiles} activeSpeakerId={activeSpeakerId} />;
}
