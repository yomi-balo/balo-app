import type { SessionStatementSource } from '@/lib/analytics/server';

/**
 * BAL-441 — the `?from` whitelist for `session_statement_viewed`'s `source` dimension. Copied
 * shape from `meetings/[meetingId]/page.tsx:49-62`: a `Readonly<Record<string, T>>` + an
 * `Object.hasOwn` guard — NEVER a bare index (an object-literal index resolves INHERITED keys,
 * so `?from=constructor` would otherwise yield the `Object` constructor typed as a source).
 *
 * ⚠ `'billing'` is deliberately NOT a key here — see `SessionStatementSource`'s docblock.
 */
const ENTRY_SOURCE_BY_PARAM: Readonly<Record<string, SessionStatementSource>> = {
  money_block: 'money_block',
};

/** Unrecognised (or absent) `?from` values fall through to `'direct'`. */
export function resolveStatementEntrySource(from: string | undefined): SessionStatementSource {
  if (from === undefined) return 'direct';
  if (!Object.hasOwn(ENTRY_SOURCE_BY_PARAM, from)) return 'direct';
  return ENTRY_SOURCE_BY_PARAM[from] ?? 'direct';
}
