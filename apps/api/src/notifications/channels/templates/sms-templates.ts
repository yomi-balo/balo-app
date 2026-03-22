const templates: Record<string, (data: Record<string, unknown>) => string> = {
  'booking-confirmed-sms': (data) => {
    const expertName = (data.expertName as string) ?? 'your expert';
    const date = (data.date as string) ?? 'the scheduled time';
    return `Balo: Your consultation with ${expertName} is confirmed for ${date}. Details at balo.expert`;
  },

  'booking-reminder-sms': () => {
    return 'Balo: Reminder - your consultation starts in 30 min. Join at balo.expert';
  },
};

export function getSmsTemplate(templateName: string, data: Record<string, unknown>): string {
  const factory = templates[templateName];
  if (!factory) {
    throw new Error(`Unknown SMS template: ${templateName}`);
  }
  return factory(data);
}
