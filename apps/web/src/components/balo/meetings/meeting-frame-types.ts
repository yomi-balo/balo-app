import type { ValidatedGrant } from '@/lib/meetings/validate-grant';

/**
 * BAL-435 — the frame's prop shape, declared OUTSIDE the implementation.
 *
 * ⚠⚠ IT LIVES HERE SO `meeting-frame.tsx` (the `dynamic()` wrapper) CAN TYPE THE LAZY COMPONENT
 * WITHOUT IMPORTING THE IMPLEMENTATION. A `import type { … } from './meeting-frame-impl'` is
 * erased at build, but one careless value import in a later edit would re-couple the graph and
 * put the whole Daily bundle back into the initial chunk of the public `/join/*` routes — the
 * exact failure the boundary exists to prevent. A separate types module makes that impossible
 * rather than merely unlikely.
 */
export interface MeetingFrameProps {
  /** ⚠ ALREADY VALIDATED at the seam. The token and the room URL go to `daily.join()` only. */
  readonly grant: ValidatedGrant;
  /** ⚠ Attached to the primary heading of EVERY state the frame renders. */
  readonly headingRef?: React.Ref<HTMLHeadingElement>;
}
