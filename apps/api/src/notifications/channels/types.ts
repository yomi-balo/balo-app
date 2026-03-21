export interface DeliveryPayload {
  recipientId: string;
  channel: string; // 'email' | 'sms' | 'in-app' | 'push'
  template: string;
  event: string;
  data: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export interface DeliveryResult {
  success: boolean;
  provider: string;
  providerMessageId?: string;
  error?: string;
}
