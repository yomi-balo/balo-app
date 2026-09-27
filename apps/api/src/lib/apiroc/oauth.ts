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
  /**
   * Balo's stable reference for this expert — carried by the vendor as `externalId` on the End
   * User Account it creates.
   *
   * ⚠ THIS IS A SECURITY BINDING, NOT A LABEL (BAL-397 fix round). An earlier revision of this
   * docblock said it was "not read back by the callback", and that was true — which is exactly
   * why the callback trusted a browser-supplied `endUserAccountId` verbatim and could be made
   * to repoint one expert's connection at another expert's calendar. `routes/calendar/auth.ts`
   * now fetches the named account via `endUserAccounts.get` and REQUIRES
   * `account.externalId === statePayload.expertProfileId` before it persists anything. Pass
   * anything other than the expert profile id here and every connect will fail closed.
   */
  readonly externalId: string;
  /**
   * BAL-575 — an optional email prefill, forwarded to the vendor only when non-empty. Google
   * pre-selects the matching account in its chooser; Microsoft prefills the sign-in field — the
   * SDK forwards the parameter when present [stat], but whether either provider visibly acts on
   * it is unverified against the live sandbox (apiroc skill). This is a convenience, not a
   * guard: the signed-in party can still choose or sign in as a different account. What actually
   * stops a reconnect from landing on the wrong one is `calendarRepository.upsertApirocConnection`'s
   * `setWhere` refusal on a live row's `end_user_account_id` — NOT the ownership check (which a
   * different account the same expert signs into still passes, since Balo's own `externalId`
   * travels with every account it creates) and NOT this hint.
   */
  readonly loginHint?: string;
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
    // BAL-575 — never `prompt`: forcing the account chooser is out of scope; only a prefill
    // is sent.
    ...(params.loginHint ? { loginHint: params.loginHint } : {}),
  });
}
