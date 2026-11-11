'use client';

import { useRouter } from 'next/navigation';
import { useRoomReadyRefetch } from '@/lib/meetings/use-room-ready-refetch';

/**
 * BAL-581 — while `active` (inside the case join window with no ready call room), re-run the
 * Server Component on the shared bounded schedule (`useRoomReadyRefetch`) so the Join appears once
 * the venue repair lands, and the ended state appears once the sweep ends the meeting, without a
 * manual reload.
 */
export function useRoomReadyRefresh(active: boolean, scheduledStartIso: string): void {
  const router = useRouter();
  useRoomReadyRefetch(active, scheduledStartIso, () => router.refresh());
}
