import type { SessionUser } from '@/lib/auth/session';
import { isPlatformAdmin } from '@/lib/auth/is-admin';
import type { RequestLens } from '@/lib/project-request/resolve-request-lens';

/**
 * Portfolio lens resolution (BAL-274 / A7 — D1). Pure + synchronous, client-safe
 * (no `@balo/db` value import, no `server-only`) so it can be unit-tested in
 * isolation and the shell could read its output if ever needed.
 *
 * The PORTFOLIO lens is a VIEW CHOOSER — which "state of your world" the user is
 * looking at. It is NOT the per-request authorization lens (`resolveRequestLens`,
 * which is `activeMode`-agnostic and gates a single request). They are different
 * concerns: an out-of-bounds `?lens=` here silently falls back to the default
 * (never `notFound()` — a bad view choice is not an access violation).
 */

export type PortfolioLens = RequestLens | 'agency';

/** Server-derived facts the pure resolver cannot read itself. */
export interface PortfolioLensOptions {
  /** The viewer administers an agency that has other linked experts (BAL-631). */
  canOverseeAgency: boolean;
}

export interface ResolvedPortfolioLens {
  /** The lens to render. */
  lens: PortfolioLens;
  /** Lenses this viewer qualifies for — drives the segmented control visibility. */
  allowedLenses: PortfolioLens[];
}

/** True when the viewer has an expert profile (qualifies for the expert lens). */
function isExpert(user: SessionUser): boolean {
  return user.expertProfileId !== undefined;
}

/**
 * The lenses this viewer qualifies for, in display order (client → expert →
 * agency → admin). `client` is always present (every user has a `companyId`);
 * `expert` only with an `expertProfileId`; `agency` only when the page resolved
 * the viewer as an agency overseer; `admin` only with an admin platform role.
 */
function allowedLensesFor(user: SessionUser, opts: PortfolioLensOptions): PortfolioLens[] {
  const allowed: PortfolioLens[] = ['client'];
  if (isExpert(user)) allowed.push('expert');
  if (opts.canOverseeAgency) allowed.push('agency');
  if (isPlatformAdmin(user)) allowed.push('admin');
  return allowed;
}

/**
 * The DEFAULT lens, derived server-side (mirrors `resolveRequestLens`
 * precedence — admins monitor first):
 *  1. platform admin → `admin`,
 *  2. else `activeMode === 'expert'` with an expert profile → `expert`,
 *  3. else → `client`.
 * `agency` is never the default, for any viewer.
 */
function defaultLensFor(user: SessionUser): PortfolioLens {
  if (isPlatformAdmin(user)) return 'admin';
  if (user.activeMode === 'expert' && isExpert(user)) return 'expert';
  return 'client';
}

/**
 * Resolve the portfolio lens for a viewer, honouring an explicit (validated)
 * `?lens=` request. The requested lens wins ONLY if the viewer is allowed it;
 * any out-of-bounds / undefined request silently falls back to the default.
 */
export function resolvePortfolioLens(
  user: SessionUser,
  requestedLens?: string,
  opts: PortfolioLensOptions = { canOverseeAgency: false }
): ResolvedPortfolioLens {
  const allowedLenses = allowedLensesFor(user, opts);
  const fallback = defaultLensFor(user);

  if (requestedLens !== undefined && (allowedLenses as string[]).includes(requestedLens)) {
    return { lens: requestedLens as PortfolioLens, allowedLenses };
  }

  return { lens: fallback, allowedLenses };
}
