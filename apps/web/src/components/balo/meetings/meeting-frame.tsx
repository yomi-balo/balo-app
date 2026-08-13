'use client';

import dynamic from 'next/dynamic';
import { MeetingConnectingCard } from './meeting-connecting-card';
import type { MeetingFrameProps } from './meeting-frame-types';

/**
 * BAL-435 — ⚠⚠ **THE CODE-SPLIT WRAPPER. THIS FILE IMPORTS NOTHING FROM `@daily-co`.**
 *
 * It follows the repo's ONE existing `next/dynamic` precedent verbatim
 * (`components/balo/rich-text-editor.tsx`): a `'use client'` wrapper holding
 * `dynamic(() => import('./x-impl'), { ssr: false, loading })`, with the implementation in a
 * sibling `*-impl` file.
 *
 * ⚠ `ssr: false` IS LEGAL HERE because this module is already `'use client'`. Next 15+ forbids
 * `ssr: false` from a Server Component.
 *
 * ⚠ THE `loading:` FALLBACK IS THE **SHIPPED** "Connecting…" CARD, byte for byte — already an
 * `<output>` live region, already `aria-busy`-free. The chunk fetch is now what it announces.
 */
export const MeetingFrame = dynamic<MeetingFrameProps>(
  () => import('./meeting-frame-impl').then((mod) => mod.MeetingFrame),
  {
    ssr: false,
    loading: () => <MeetingConnectingCard />,
  }
);

/**
 * ⚠⚠ START THE VENDOR CHUNK FETCH **IN PARALLEL WITH THE GRANT FETCH**, not after it.
 *
 * The AC is "join-to-talking under 3 seconds for logged-in users" and the vendor chunk is the
 * long pole. This uses the **SAME module specifier** as the `dynamic()` above, so the bundler
 * dedupes both to one chunk and the second call is free.
 *
 * ⚠ NOT `void`-PREFIXED — this repo does not enable type-aware linting, so `no-floating-promises`
 * never fires and SonarCloud S3735 flags the operator (the position `lobby-client.tsx` and
 * `use-admission-poll.ts` already state by name).
 *
 * **HAND-OFF FOR BAL-421:** its "join the call" button should call this on `onMouseEnter` /
 * `onFocus`.
 */
export function preloadMeetingFrame(): void {
  import('./meeting-frame-impl').catch(() => {
    // A failed preload is not a failure: the `dynamic()` import retries when the frame mounts.
  });
}
