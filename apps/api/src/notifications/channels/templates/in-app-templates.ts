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
};

export function getInAppTemplate(templateName: string, data: Record<string, unknown>): InAppOutput {
  const factory = templates[templateName];
  if (!factory) {
    return { title: 'Notification', body: 'You have a new notification' };
  }
  return factory(data);
}
