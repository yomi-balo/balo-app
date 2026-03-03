export const AUTH_EVENTS = {
  MODAL_OPENED: 'auth_modal_opened',
  METHOD_SELECTED: 'auth_method_selected',
  LOGIN_COMPLETED: 'auth_login_completed',
  LOGIN_FAILED: 'auth_login_failed',
  SIGNUP_COMPLETED: 'auth_signup_completed',
  LOGOUT_COMPLETED: 'auth_logout_completed',
  PASSWORD_RESET_REQUESTED: 'auth_password_reset_requested',
  OAUTH_REDIRECT_STARTED: 'auth_oauth_redirect_started',
} as const;

export type AuthMethod = 'email' | 'google' | 'microsoft';

export interface AuthEventMap {
  [AUTH_EVENTS.MODAL_OPENED]: {
    view: 'sign-in' | 'sign-up';
    trigger?: string;
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
  [AUTH_EVENTS.LOGOUT_COMPLETED]: Record<string, never>;
  [AUTH_EVENTS.PASSWORD_RESET_REQUESTED]: Record<string, never>;
  [AUTH_EVENTS.OAUTH_REDIRECT_STARTED]: {
    provider: 'google' | 'microsoft';
  };
}
