'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Sentry from '@sentry/nextjs';
import { useAuthModal } from '@/hooks/use-auth-modal';
import { loadSearchBookingAction } from '@/lib/booking/actions/load-search-booking';
import type { BookingContext, BookingFlowExpert } from '@/components/booking';

export interface SearchBookingLaunch {
  expert: BookingFlowExpert;
  context: BookingContext;
  viewerEmailDomain: string | null;
}

interface SearchBooking {
  /** The last loaded booking. Close only flips `open`; the next Book click replaces it. */
  launch: SearchBookingLaunch | null;
  open: boolean;
  /** The username whose booking is loading, so only that card's button spins. */
  pendingUsername: string | null;
  /** `onStart` runs only when the click is accepted, not when a load already in flight drops it. */
  book: (username: string, onStart?: () => void) => void;
  close: () => void;
}

/**
 * Opens the booking flow in place on the expert search grid. The click loads the expert's
 * booking context first and only then opens the dialog, so the wrapper never flashes a loading
 * state for the company question (same contract as the profile page's server read). A
 * signed-out visitor signs in and the load reruns once; anything the profile page handles better
 * (paused or unknown expert, a failed load, still signed out after that rerun) falls back to its
 * `?book=1` deep link.
 */
export function useSearchBooking(): SearchBooking {
  const router = useRouter();
  const authModal = useAuthModal();
  const [launch, setLaunch] = useState<SearchBookingLaunch | null>(null);
  const [open, setOpen] = useState(false);
  const [pendingUsername, setPendingUsername] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const run = useCallback(
    (username: string, retried: boolean) => {
      inFlightRef.current = true;
      setPendingUsername(username);

      const fallback = (): void => router.push(`/experts/${username}?book=1&src=search`);
      const load = async (): Promise<void> => {
        try {
          const result = await loadSearchBookingAction({ username });
          if (result.ok) {
            setLaunch({
              expert: result.expert,
              context: result.context,
              viewerEmailDomain: result.viewerEmailDomain,
            });
            setOpen(true);
          } else if (result.reason === 'signed_out' && !retried) {
            authModal.open({
              onSuccess: () => {
                router.refresh();
                run(username, true);
              },
            });
          } else {
            fallback();
          }
        } catch (error) {
          Sentry.captureException(error, { tags: { feature: 'booking', step: 'search_launch' } });
          fallback();
        } finally {
          inFlightRef.current = false;
          setPendingUsername(null);
        }
      };
      void load();
    },
    [router, authModal]
  );

  const book = useCallback(
    (username: string, onStart?: () => void) => {
      if (inFlightRef.current) return;
      onStart?.();
      run(username, false);
    },
    [run]
  );

  const close = useCallback(() => setOpen(false), []);

  return { launch, open, pendingUsername, book, close };
}
