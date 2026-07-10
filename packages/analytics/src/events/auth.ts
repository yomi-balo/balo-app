export const AUTH_EVENTS = {
  MODAL_OPENED: 'auth_modal_opened',
  METHOD_SELECTED: 'auth_method_selected',
  LOGIN_COMPLETED: 'auth_login_completed',
  LOGIN_FAILED: 'auth_login_failed',
  SIGNUP_COMPLETED: 'auth_signup_completed',
  SIGNUP_FAILED: 'auth_signup_failed',
  LOGOUT_COMPLETED: 'auth_logout_completed',
  PASSWORD_RESET_REQUESTED: 'auth_password_reset_requested',
  EMAIL_VERIFIED: 'auth_email_verified',
  OAUTH_REDIRECT_STARTED: 'auth_oauth_redirect_started',
  // BAL-180: Password reset page
  PASSWORD_RESET_COMPLETED: 'auth_password_reset_completed',
  PASSWORD_RESET_FAILED: 'auth_password_reset_failed',
  PASSWORD_RESET_TOKEN_MISSING: 'auth_password_reset_token_missing',
  // BAL-184: Unified auth flow
  STEP_CHANGED: 'auth_step_changed',
  VERIFICATION_CODE_SUBMITTED: 'auth_verification_code_submitted',
  VERIFICATION_CODE_RESENT: 'auth_verification_code_resent',
  // BAL-350: compulsory company-name capture, reshaped into the onboarding
  // company step. Fired once when the client create branch save succeeds. Value
  // uses the ticket-literal name (intentionally drops the sibling `auth_` prefix).
  SIGNUP_COMPANY_NAME_CAPTURED: 'signup_company_name_captured',
  // BAL-346: join-sibling of SIGNUP_COMPANY_NAME_CAPTURED — fired once when the
  // client auto-joins the domain-matched company from the onboarding company step
  // (DORMANT in v1). Value follows the same ticket-literal `signup_` convention.
  SIGNUP_COMPANY_JOINED: 'signup_company_joined',
} as const;

export type AuthMethod = 'email' | 'google' | 'microsoft';

/**
 * BAL-350 coarse auth-method signal — the SINGLE SOURCE OF TRUTH for the
 * `auth_method` analytics dimension. Distinct from `AuthMethod` above (this one
 * carries the `oauth_` prefix). Reused by the onboarding event maps and by
 * apps/web's session mapper (`mapWorkosAuthMethod` re-exports this type), so the
 * union can never drift across the three call sites. Optional at call sites:
 * pre-existing sessions / unknown providers leave it unset.
 */
export type AuthMethodSignal = 'email' | 'oauth_google' | 'oauth_microsoft';

export type AuthStepName = 'email' | 'password' | 'signup' | 'verify' | 'forgot';

export interface AuthEventMap {
  [AUTH_EVENTS.MODAL_OPENED]: {
    view: AuthStepName | 'sign-in' | 'sign-up'; // Legacy values kept until auth-modal.tsx is fully migrated
    trigger?: string;
    page: string;
  };
  [AUTH_EVENTS.METHOD_SELECTED]: {
    method: AuthMethod;
  };
  [AUTH_EVENTS.LOGIN_COMPLETED]: {
    method: AuthMethod;
    is_returning_user: boolean;
  };
  [AUTH_EVENTS.LOGIN_FAILED]: {
    method: AuthMethod;
    error_message: string;
  };
  [AUTH_EVENTS.SIGNUP_COMPLETED]: {
    method: AuthMethod;
  };
  [AUTH_EVENTS.SIGNUP_FAILED]: {
    method: AuthMethod;
    error_message: string;
  };
  [AUTH_EVENTS.LOGOUT_COMPLETED]: Record<string, never>;
  [AUTH_EVENTS.PASSWORD_RESET_REQUESTED]: Record<string, never>;
  [AUTH_EVENTS.PASSWORD_RESET_COMPLETED]: Record<string, never>;
  [AUTH_EVENTS.PASSWORD_RESET_FAILED]: {
    error_message: string;
  };
  [AUTH_EVENTS.PASSWORD_RESET_TOKEN_MISSING]: Record<string, never>;
  [AUTH_EVENTS.EMAIL_VERIFIED]: Record<string, never>;
  [AUTH_EVENTS.OAUTH_REDIRECT_STARTED]: {
    provider: 'google' | 'microsoft';
  };
  // BAL-184: Unified auth flow
  [AUTH_EVENTS.STEP_CHANGED]: {
    from: AuthStepName;
    to: AuthStepName;
  };
  [AUTH_EVENTS.VERIFICATION_CODE_SUBMITTED]: {
    success: boolean;
  };
  [AUTH_EVENTS.VERIFICATION_CODE_RESENT]: Record<string, never>;
  // BAL-350: fired once at the onboarding company step when the client create
  // branch save (workspace rename + onboarding completion) succeeds.
  // `domain_type` folds the resolve fail-open case into 'new'. `auth_method` is
  // the coarse BAL-350 signal (`oauth_*`), distinct from the `AuthMethod` union
  // above; optional because pre-existing sessions / unknown providers are unset.
  [AUTH_EVENTS.SIGNUP_COMPANY_NAME_CAPTURED]: {
    domain_type: 'blocked' | 'new';
    prefill_used: boolean;
    prefill_edited: boolean;
    auth_method?: AuthMethodSignal;
  };
  // BAL-346: fired once when the client auto-joins the domain-matched company at
  // the onboarding company step (DORMANT in v1). `party_type` is always 'company'
  // in Scope A; `auth_method` is the coarse BAL-350 signal, optional as elsewhere.
  [AUTH_EVENTS.SIGNUP_COMPANY_JOINED]: {
    party_type: 'company';
    auth_method?: AuthMethodSignal;
  };
}

// BAL-360: SERVER-side auth events (the OAuth callback runs server-side and had no
// analytics until now). Distinct from the CLIENT `AUTH_EVENTS`/`AuthEventMap` above.
export const AUTH_SERVER_EVENTS = {
  OAUTH_CALLBACK_RELINK: 'oauth_callback_relink',
  OAUTH_CALLBACK_CONFLICT_409: 'oauth_callback_conflict_409',
} as const;

export interface AuthServerEventMap {
  // Fired after a successful workosId re-link onto a live verified-email user.
  [AUTH_SERVER_EVENTS.OAUTH_CALLBACK_RELINK]: { distinct_id: string };
  // Fired on the conflict branch (live email, unverified profile → refused re-link).
  [AUTH_SERVER_EVENTS.OAUTH_CALLBACK_CONFLICT_409]: { distinct_id: string };
}
