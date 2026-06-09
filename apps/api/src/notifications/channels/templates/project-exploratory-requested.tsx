import { ProjectStatusEmail, type ProjectEmailRecipientProps } from './shared.js';

/**
 * Client email — Balo wants a quick scoping call before inviting experts. CTA
 * links straight to the request-detail page, where the "Book exploratory call"
 * CTA lives. Layout lives in the shared `ProjectStatusEmail`; only copy varies.
 */
export function ProjectExploratoryRequestedEmail({
  firstName = 'there',
  projectTitle = 'your project',
  projectRequestId,
  baseUrl,
}: Readonly<ProjectEmailRecipientProps>) {
  return (
    <ProjectStatusEmail
      previewText={`${firstName}, let's scope ${projectTitle} on a quick call`}
      baseUrl={baseUrl}
      projectRequestId={projectRequestId}
      firstName={firstName}
      pillLabel="📞 Quick call"
      heroHeading="Balo wants a quick scoping call."
      heroSubtext="A 20-minute call helps us match you precisely."
      bodyText="Before we invite experts, we'd like a short exploratory call to sharpen the scope of your project. It takes about 20 minutes and means the specialists we line up are the right fit from day one."
      summaryLabel="Your project"
      projectTitle={projectTitle}
      calloutText="Open your request and pick a time that suits you. After the call, we'll invite the experts best suited to your scope."
      ctaLabel="Book your call →"
      supportPrefix="Questions about your project?"
    />
  );
}
