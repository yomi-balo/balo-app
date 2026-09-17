import 'server-only';

import { log } from '@/lib/logging';
import type { UpNextData, UpNextRowView } from './up-next-view-types';

/**
 * BAL-566 — the catch boundary. Both slots pass this a thunk (`() => loadCompanyUpNext(...)` /
 * `() => loadExpertUpNext(...)`) so a read failure is logged HERE, at the boundary that turns it
 * into a user-facing state, rather than deep inside the loader.
 *
 * BAL-566 fix round 1 (F7) — overloaded on whether the loader itself CAN return `null`.
 * `loadExpertUpNext` never does (an expert always participates in their own calendar), so a call
 * built from it resolves to `Promise<UpNextData>` with no null branch to coalesce; only
 * `loadCompanyUpNext` (which returns `null` when the viewer does not participate in the
 * workspace company, R1) needs the wider `Promise<UpNextData | null>` shape. This makes the
 * "never null" claim a type-checked fact instead of a comment attached to a runtime `?? {...}`.
 */
export async function readUpNextData(
  read: () => Promise<readonly UpNextRowView[]>,
  logContext: Readonly<Record<string, string>>
): Promise<UpNextData>;
export async function readUpNextData(
  read: () => Promise<readonly UpNextRowView[] | null>,
  logContext: Readonly<Record<string, string>>
): Promise<UpNextData | null>;
export async function readUpNextData(
  read: () => Promise<readonly UpNextRowView[] | null>,
  logContext: Readonly<Record<string, string>>
): Promise<UpNextData | null> {
  try {
    const rows = await read();
    return rows === null ? null : { kind: 'ready', rows };
  } catch (error) {
    log.error('Dashboard up next read failed', {
      ...logContext,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { kind: 'error' };
  }
}
