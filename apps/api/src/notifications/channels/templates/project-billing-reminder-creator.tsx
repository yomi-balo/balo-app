import {
  ProjectBillingReminderEmail,
  type ProjectBillingReminderEmailProps,
} from './project-billing-reminder-owner.js';

/**
 * Creator-side billing reminder (BAL-324) — an FYI to the request creator when
 * they are NOT the company owner (and are a company member). NO action button:
 * they can't complete billing, so the copy nudges them to prod the account owner.
 * Reuses the shared, role-parameterised `ProjectBillingReminderEmail` so the two
 * variants stay in lockstep (mirrors the kickoff-approved expert/client wrappers).
 */
export function ProjectBillingReminderCreatorEmail(
  props: Readonly<ProjectBillingReminderEmailProps>
): ReturnType<typeof ProjectBillingReminderEmail> {
  return <ProjectBillingReminderEmail role="creator" {...props} />;
}
