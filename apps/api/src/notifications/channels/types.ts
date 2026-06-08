export interface DeliveryPayload {
  recipientId: string;
  /**
   * Literal recipient email, set only for non-user recipients (e.g. the `admin`
   * ops inbox). When present, the email channel uses it directly and bypasses the
   * `usersRepository.findById` lookup.
   */
  recipientEmail?: string;
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
