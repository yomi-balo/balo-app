import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

/** Which side of the engagement this kickoff-approved email addresses. */
export type KickoffRole = 'expert' | 'client';

/** Shared props for the kickoff-approved emails (BAL-291). */
export interface ProjectKickoffApprovedEmailProps extends ProjectEmailRecipientProps {
  /** The opposite party's display name — the expert for the client email, the client for the expert email. */
  readonly counterpartName: string;
  /**
   * Client's company — appended on first mention as "Name @ Company". Only the
   * client party carries a company, so this surfaces on the EXPERT email (where
   * the counterpart is the client); ignored when empty.
   */
  readonly counterpartCompany?: string;
}

/**
 * Kickoff-approved email (BAL-291) — the client approved kickoff and the
 * engagement is live. One layout, parameterised by `role`, so the expert and
 * client variants share the shared `ProjectStatusEmail` body and stay in lockstep;
 * only the copy varies. Thin per-role wrappers (`ProjectKickoffApprovedExpertEmail`,
 * `ProjectKickoffApprovedClientEmail`) bind `role` for the template registry.
 */
export function ProjectKickoffApprovedEmail({
  role,
  firstName = 'there',
  counterpartName,
  counterpartCompany = '',
  projectTitle = 'a project',
  projectRequestId,
  baseUrl,
}: Readonly<ProjectKickoffApprovedEmailProps & { readonly role: KickoffRole }>) {
  // First mention follows the "Name @ Company" rule; bare name when no company.
  const who = counterpartCompany ? `${counterpartName} @ ${counterpartCompany}` : counterpartName;

  const copy =
    role === 'expert'
      ? {
          previewText: `${firstName}, kickoff is approved — time to deliver: ${projectTitle}`,
          heroHeading: 'Kickoff approved — time to deliver.',
          heroSubtext: 'The client gave the green light. The engagement is officially live.',
          bodyText: `${who} approved the kickoff for this project. Everything is in place — review the agreed scope and milestones, then get started. Keep the client in the loop as you go.`,
          calloutText:
            "You're cleared to begin. Work through the agreed milestones and message the client directly to coordinate as the project moves.",
          ctaLabel: 'Open the project →',
        }
      : {
          previewText: `${firstName}, kickoff is approved — ${counterpartName} is ready: ${projectTitle}`,
          heroHeading: `Kickoff approved — ${counterpartName} is ready.`,
          heroSubtext: 'You gave the green light. The engagement is officially live.',
          bodyText: `You approved the kickoff for this project. ${counterpartName} is ready to begin and will work through the agreed milestones. You can follow progress and message them directly at any time.`,
          calloutText:
            'Your expert is getting started. Watch this space for milestone updates, and message them directly whenever you need to coordinate.',
          ctaLabel: 'Open the project →',
        };

  return (
    <ProjectStatusEmail
      previewText={copy.previewText}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="🚀 Kickoff approved"
      heroHeading={copy.heroHeading}
      heroSubtext={copy.heroSubtext}
      bodyText={copy.bodyText}
      summaryLabel="Project request"
      projectTitle={projectTitle}
      calloutText={copy.calloutText}
      ctaLabel={copy.ctaLabel}
      supportPrefix="Questions about this engagement?"
    />
  );
}

/** Expert-side kickoff-approved email — counterpart is the approving client. */
export function ProjectKickoffApprovedExpertEmail(
  props: Readonly<ProjectKickoffApprovedEmailProps>
): ReturnType<typeof ProjectKickoffApprovedEmail> {
  return <ProjectKickoffApprovedEmail role="expert" {...props} />;
}

/** Client-side kickoff-approved email — counterpart is the delivering expert. */
export function ProjectKickoffApprovedClientEmail(
  props: Readonly<ProjectKickoffApprovedEmailProps>
): ReturnType<typeof ProjectKickoffApprovedEmail> {
  return <ProjectKickoffApprovedEmail role="client" {...props} />;
}
