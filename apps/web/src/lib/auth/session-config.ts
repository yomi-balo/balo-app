/**
 * Session cookie configuration shared between server code and Edge middleware.
 * NO 'server-only' import — must be importable from middleware (Edge Runtime).
 */

export const COOKIE_NAME = 'balo_session';

export const sessionConfig = {
  password: process.env.WORKOS_COOKIE_PASSWORD!,
  cookieName: COOKIE_NAME,
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax' as const,
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
};
