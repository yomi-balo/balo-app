import { getOAuthUrl } from '@apiroc/unified-calendar-api-node-sdk/oauth';
import { ApirocConfigError } from './errors.js';

/**
 * BAL-396 §1/§10.1 (Objection 3) — one of a handful of legitimate provider-literal sites
 * (the others: the connect-surface zod enum / union in `routes/calendar/`, and
 * `./provider-labels.ts`'s display-label map, added when Scan B went tree-wide — see its
 * docblock), and the reason THIS one must live here rather than in `services/calendar/`: the
 * SDK's `getOAuthUrl` requires the UPPERCASE `ProviderType` string
 * (`dist/oauth/index.d.ts:12`), while every Balo-side surface (the DB column,
 * `calendar_connections.provider`, the connect-flow zod enum) speaks lowercase
 * `'google' | 'microsoft'`. This function is the ONE translation point for that direction.
 */
export type ApirocOAuthProvider = 'GOOGLE' | 'MICROSOFT';

/**
 * `'google' → 'GOOGLE'`, `'microsoft' → 'MICROSOFT'`. Deliberately narrow: iCloud is PARKED
 * (apiroc skill, Constraint 8) and is not a member of Balo's provider union anywhere.
 */
export function toApirocProviderType(provider: 'google' | 'microsoft'): ApirocOAuthProvider {
  if (provider === 'google') return 'GOOGLE';
  return 'MICROSOFT';
}

export interface BuildApirocAuthorizeUrlParams {
  readonly provider: 'google' | 'microsoft';
  /** The signed CSRF state (`services/calendar/connect-state.ts`) — round-trips unverified
   *  through the vendor and back to Balo's callback. */
  readonly state: string;
  /** Balo's stable reference for this expert — carried by the vendor as `externalId`, not
   *  read back by the callback (the callback returns `endUserAccountId` + `state` only). */
  readonly externalId: string;
}

/**
 * The Apiroc hosted-OAuth authorize URL (apiroc skill, "SDK Initialisation"). Throws
 * `ApirocConfigError` — a named throw, never a silent `!` — when `APIROC_APP_ID` or
 * `APIROC_REDIRECT_URI` is unset (CLAUDE.md: "every variable is validated by a call-site
 * guard"; there is no zod env schema in this repo).
 */
export function buildApirocAuthorizeUrl(params: BuildApirocAuthorizeUrlParams): string {
  const appId = process.env.APIROC_APP_ID;
  const redirectUrl = process.env.APIROC_REDIRECT_URI;
  if (!appId) {
    throw new ApirocConfigError('APIROC_APP_ID is not set');
  }
  if (!redirectUrl) {
    throw new ApirocConfigError('APIROC_REDIRECT_URI is not set');
  }

  return getOAuthUrl(appId, toApirocProviderType(params.provider), {
    redirectUrl,
    externalId: params.externalId,
    state: params.state,
  });
}
