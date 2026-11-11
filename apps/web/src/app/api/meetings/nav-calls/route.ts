import { NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/auth';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { log } from '@/lib/logging';
import { loadNavCalls } from '@/lib/meetings/load-nav-calls';
import type { NavCallsResponse } from '@/lib/meetings/nav-call-view-types';
import { navWorkspaceTypeOf } from '@/lib/navigation/nav-context';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/**
 * BAL-636 — the top-nav call pill's feed. Every call whose join window may be open soon, across
 * the viewer's company workspace AND their own expert calendar. Workspace scoping only: the call
 * route re-authorizes the join itself.
 */
export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const now = new Date();

  if (isImpersonatedSession(user)) {
    const body: NavCallsResponse = {
      serverNowIso: now.toISOString(),
      impersonating: true,
      calls: [],
    };
    return NextResponse.json(body, { headers: NO_STORE });
  }

  try {
    const calls = await loadNavCalls({
      actorUserId: user.id,
      workspaceType: navWorkspaceTypeOf(user),
      companyId: user.companyId || null,
      expertProfileId: user.expertProfileId || null,
      now,
    });
    const body: NavCallsResponse = {
      serverNowIso: now.toISOString(),
      impersonating: false,
      calls,
    };
    return NextResponse.json(body, { headers: NO_STORE });
  } catch (error) {
    log.error('Failed to load nav calls', {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: NO_STORE }
    );
  }
}
