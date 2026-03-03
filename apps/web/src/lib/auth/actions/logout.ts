'use server';

import 'server-only';

import { redirect } from 'next/navigation';
import { getSession } from '../session';
import { log } from '@/lib/logging';

export async function logoutAction(): Promise<void> {
  const session = await getSession();
  const userId = session.user?.id;
  session.destroy();

  log.info('User signed out', { userId });

  redirect('/');
}
