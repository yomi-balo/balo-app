/** Mask phone number for logging — show last 4 digits only. */
export function maskPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return '****' + phone.slice(-4);
}

/** Cached Brevo client — created lazily on first use. */
export interface BrevoSmsClient {
  transactionalSms: {
    sendTransacSms: (params: Record<string, unknown>) => Promise<{ messageId?: number }>;
  };
}

let brevoClient: BrevoSmsClient | null = null;

export async function getBrevoClient(): Promise<BrevoSmsClient> {
  if (brevoClient) return brevoClient;

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not configured');
  }

  const { BrevoClient } = await import('@getbrevo/brevo');
  brevoClient = new BrevoClient({ apiKey }) as unknown as BrevoSmsClient;
  return brevoClient;
}
