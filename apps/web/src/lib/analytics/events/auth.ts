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
  // BAL-184: Unified auth flow
  STEP_CHANGED: 'auth_step_changed',
  VERIFICATION_CODE_SUBMITTED: 'auth_verification_code_submitted',
  VERIFICATION_CODE_RESENT: 'auth_verification_code_resent',
} as const;

export type AuthMethod = 'email' | 'google' | 'microsoft';

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
  [AUTH_EVENTS.EMAIL_VERIFIED]: Record<string, never>;
  [AUTH_EVENTS.OAUTH_REDIRECT_STARTED]: {
    provider: 'google' | 'microsoft';
  };
  // BAL-184: Unified auth flow
  [AUTH_EVENTS.STEP_CHANGED]: {
    from: string;
    to: string;
  };
  [AUTH_EVENTS.VERIFICATION_CODE_SUBMITTED]: {
    success: boolean;
  };
  [AUTH_EVENTS.VERIFICATION_CODE_RESENT]: Record<string, never>;
}
