export { getWorkOS, clientId, sessionConfig } from './config';
export {
  getSession,
  getCurrentUser,
  requireUser,
  requireOnboardedUser,
  getCompanyContext,
} from './session';
export type { SessionUser, SessionData } from './session';
export { resolveApprovedExpert, APPROVED_EXPERT_REQUIRED_ERROR } from './approved-expert';
export type { ApprovedExpertResolution, ApprovedExpertRefusal } from './approved-expert';
export type { AuthResult } from './errors';
export { mapWorkOSError } from './errors';
export { withAuth } from './with-auth';
export type { AuthenticatedSession } from './with-auth';
export {
  logoutAction,
  signUpAction,
  signInAction,
  initiateGoogleOAuth,
  initiateMicrosoftOAuth,
  forgotPasswordAction,
} from './actions';
