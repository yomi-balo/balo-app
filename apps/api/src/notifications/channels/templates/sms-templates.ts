const templates: Record<string, (data: Record<string, unknown>) => string> = {
  'booking-confirmed-sms': (data) => {
    const expertName = (data.expertName as string) ?? 'your expert';
    const date = (data.date as string) ?? 'the scheduled time';
    return `Balo: Your consultation with ${expertName} is confirmed for ${date}. Details at balo.expert`;
  },

  'booking-reminder-sms': () => {
    return 'Balo: Reminder - your consultation starts in 30 min. Join at balo.expert';
  },

  // BAL-378 (ADR-1040 Lane 2) — the two urgent, time-sensitive session moments (entering
  // grace, nearing the wrap). ≤160 chars, warm, NO "overdraft" (its client name is "extra
  // time"). Self recipient, verified-phone gated at the rule.
  'session-grace-entered-sms': () => {
    return 'Balo: Your session is continuing past your balance — the extra time settles afterward. No action needed.';
  },

  'session-near-wrap-sms': () => {
    return 'Balo: Your session is nearing the end of its extra time — top up to keep going without a break.';
  },
};

export function getSmsTemplate(templateName: string, data: Record<string, unknown>): string {
  const factory = templates[templateName];
  if (!factory) {
    throw new Error(`Unknown SMS template: ${templateName}`);
  }
  return factory(data);
}
