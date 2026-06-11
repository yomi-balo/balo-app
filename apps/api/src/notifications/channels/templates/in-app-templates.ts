interface InAppOutput {
  title: string;
  body: string;
  actionUrl?: string;
}

const templates: Record<string, (data: Record<string, unknown>) => InAppOutput> = {
  'booking-confirmed': (data) => {
    const clientName = (data.clientName as string) ?? 'A client';
    const caseId = data.caseId as string | undefined;
    return {
      title: 'New booking',
      body: `${clientName} booked a consultation`,
      actionUrl: caseId ? `/cases/${caseId}` : undefined,
    };
  },

  'new-message': (data) => {
    const caseId = data.caseId as string | undefined;
    return {
      title: 'New message',
      body: 'You have a new message in your consultation',
      actionUrl: caseId ? `/cases/${caseId}` : undefined,
    };
  },

  'project-exploratory-requested': (data) => {
    const title = (data.title as string) ?? 'your project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Book your exploratory call',
      body: `Balo wants a quick call about "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-expert-invited': (data) => {
    const title = (data.title as string) ?? 'a new project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: "You're invited to a project",
      body: `Balo invited you to express interest in "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-eoi-submitted': (data) => {
    const title = (data.title as string) ?? 'your project';
    const expertName = (data.expertName as string) ?? 'An expert';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'An expert is interested',
      body: `${expertName} expressed interest in "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-proposal-requested': (data) => {
    const title = (data.title as string) ?? 'a project';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Proposal requested',
      body: `The client requested your proposal for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-proposal-submitted': (data) => {
    const title = (data.title as string) ?? 'a project';
    const expertName = (data.expertName as string) ?? 'Your expert';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'Proposal received',
      body: `${expertName} sent a proposal for "${title}"`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-message-posted': (data) => {
    const senderName = (data.senderName as string) ?? 'Someone';
    const preview = (data.preview as string) ?? 'sent you a message';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'New message',
      body: `${senderName}: ${preview}`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },

  'project-file-shared': (data) => {
    const senderName = (data.senderName as string) ?? 'Someone';
    const fileName = (data.fileName as string) ?? 'a file';
    const projectRequestId = data.projectRequestId as string | undefined;
    return {
      title: 'New file shared',
      body: `${senderName} shared ${fileName}`,
      actionUrl: projectRequestId ? `/projects/${projectRequestId}` : undefined,
    };
  },
};

export function getInAppTemplate(templateName: string, data: Record<string, unknown>): InAppOutput {
  const factory = templates[templateName];
  if (!factory) {
    return { title: 'Notification', body: 'You have a new notification' };
  }
  return factory(data);
}
