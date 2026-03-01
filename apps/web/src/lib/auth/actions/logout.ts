'use server';

import 'server-only';

import { redirect } from 'next/navigation';
import { getSession } from '../session';

export async function logoutAction(): Promise<void> {
  const session = await getSession();
  session.destroy();
  redirect('/');
}
