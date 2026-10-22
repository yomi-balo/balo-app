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
  /** The last loaded booking; kept after close so the dialog can animate out. */
  launch: SearchBookingLaunch | null;
  open: boolean;
  /** The username whose booking is loading, so only that card's button spins. */
  pendingUsername: string | null;
  book: (username: string) => void;
  close: () => void;
}

/**
 * Opens the booking flow in place on the expert search grid. The click loads the expert's
 * booking context first and only then opens the dialog, so the wrapper never flashes a loading
 * state for the company question (same contract as the profile page's server read). A
 * signed-out visitor signs in and the load reruns; anything the profile page handles better
 * (paused or unknown expert, a failed load) falls back to its `?book=1` deep link.
 */
export function useSearchBooking(): SearchBooking {
  const router = useRouter();
  const authModal = useAuthModal();
  const [launch, setLaunch] = useState<SearchBookingLaunch | null>(null);
  const [open, setOpen] = useState(false);
  const [pendingUsername, setPendingUsername] = useState<string | null>(null);
  const inFlightRef = useRef(false);

  const book = useCallback(
    (username: string) => {
      if (inFlightRef.current) return;
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
          } else if (result.reason === 'signed_out') {
            authModal.open({
              onSuccess: () => {
                router.refresh();
                book(username);
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

  const close = useCallback(() => setOpen(false), []);

  return { launch, open, pendingUsername, book, close };
}
