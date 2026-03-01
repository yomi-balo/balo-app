'use server';

import 'server-only';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { getWorkOS, clientId } from '@/lib/auth/config';
import { isValidReturnTo } from '@/lib/auth/validation';

type OAuthProvider = 'GoogleOAuth' | 'MicrosoftOAuth';

/**
 * Initiate OAuth flow with WorkOS.
 *
 * This action is called from client components. It:
 * 1. Stores the current page URL in a cookie (so callback can redirect back)
 * 2. Gets the authorization URL from WorkOS
 * 3. Redirects the browser to the OAuth provider
 *
 * After the user authenticates with the provider, they're redirected to
 * /api/auth/callback which handles the code exchange.
 */
export async function initiateGoogleOAuth(returnTo?: string): Promise<void> {
  await initiateOAuth('GoogleOAuth', returnTo);
}

export async function initiateMicrosoftOAuth(returnTo?: string): Promise<void> {
  await initiateOAuth('MicrosoftOAuth', returnTo);
}

async function initiateOAuth(provider: OAuthProvider, returnTo?: string): Promise<never> {
  // Store return path so callback can redirect back after auth
  if (returnTo && isValidReturnTo(returnTo)) {
    const cookieStore = await cookies();
    cookieStore.set('auth_return_to', returnTo, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 600, // 10 minutes — plenty of time for OAuth round-trip
      sameSite: 'lax',
      path: '/',
    });
  }

  const authorizationUrl = getWorkOS().userManagement.getAuthorizationUrl({
    provider,
    clientId,
    redirectUri: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/callback`,
  });

  redirect(authorizationUrl);
}
