'use client';

/**
 * BAL-504 Phase 3 — re-exports `(marketing)/error.tsx` verbatim. There's no `loading.tsx` in
 * this group: a prerender never suspends, so a loading boundary here would be dead code.
 *
 * ⚠ `'use client'` IS REQUIRED IN THIS FILE ITSELF, not just in the module it re-exports from —
 * Next's build resolves the client-boundary directive per FILE, and an `error.tsx` segment
 * convention must be a Client Component regardless of what its default export re-exports.
 */
export { default } from '../(marketing)/error';
