import { WorkOS } from '@workos-inc/node';

export const workos = new WorkOS(process.env.WORKOS_API_KEY!);
export const clientId = process.env.WORKOS_CLIENT_ID!;

export const sessionConfig = {
  password: process.env.WORKOS_COOKIE_PASSWORD!,
  cookieName: 'balo_session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax' as const,
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
};
