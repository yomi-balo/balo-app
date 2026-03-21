import type { NotificationChannel } from '../engine/rules.js';

export interface DeliveryPayload {
  recipientId: string;
  channel: NotificationChannel;
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
