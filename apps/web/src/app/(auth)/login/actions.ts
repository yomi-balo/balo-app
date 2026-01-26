'use server';

import { redirect } from 'next/navigation';
import { workos, clientId } from '@/lib/auth/config';

export async function loginAction() {
  const authorizationUrl = workos.userManagement.getAuthorizationUrl({
    provider: 'authkit',
    clientId,
    redirectUri: `${process.env.NEXT_PUBLIC_APP_URL}/api/auth/callback`,
  });

  redirect(authorizationUrl);
}
