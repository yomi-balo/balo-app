import 'server-only';

import type { CaseSurfaceView } from '@/lib/cases/case-view-types';
import { errorMessage, log } from '@/lib/logging';
import { canBookInPage } from './book-in-page';
import { getCallNowView } from './call-now-api-client';
import { readCallNowRateLine } from './call-now-rate-line';
import type {
  CallNowConfirmView,
  CallNowEntry,
  CallNowViewRead,
  CaseCallNowView,
} from './call-now-types';

/**
 * The case page's Call now read, shaped for the party card. The api decides what the viewer may
 * do (`GET /cases/:id/call-now` runs the same gates `POST` enforces); this only decides what to
 * show. Never throws: a failed hop means the entry is absent and the page is unbroken.
 */

/**
 * How long the Call now read may take before the entry is dropped. The balo-api client has no abort
 * signal, so the read is raced instead, and a hung api hides the entry rather than holding the
 * page's stream open.
 *
 * ⚠ THE PAGE DOES NOT WAIT FOR THIS READ: the entry streams into the party card after the page has
 * rendered, so this cap costs nothing on a normal load. It sits well above the api's answer from a
 * distant database: at 2.5 s the expert's read (about 2.8 s) was always cut off and the expert
 * never saw the entry.
 */
const READ_TIMEOUT_MS = 6000;

async function fetchCallNowView(engagementId: string): Promise<CallNowViewRead | null> {
  try {
    const result = await getCallNowView(engagementId);
    if (result.ok) return result.data;
    log.warn('Call now view unavailable — entry hidden', {
      engagementId,
      status: result.status,
      code: result.code,
    });
  } catch (error) {
    log.warn('Call now view read threw — entry hidden', {
      engagementId,
      error: errorMessage(error),
    });
  }
  return null;
}

/**
 * Starts the api read. Start it beside `loadCase` so it adds no wait; it never rejects and
 * resolves `null` once {@link READ_TIMEOUT_MS} has passed without an answer.
 */
export async function readCallNowView(engagementId: string): Promise<CallNowViewRead | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      log.warn('Call now view timed out — entry hidden', {
        engagementId,
        timeoutMs: READ_TIMEOUT_MS,
      });
      resolve(null);
    }, READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fetchCallNowView(engagementId), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function entryFor(read: CallNowViewRead): CallNowEntry | null {
  if (read.canCallNow) return 'button';
  return read.reason;
}

async function buildConfirm(
  view: CaseSurfaceView,
  read: CallNowViewRead
): Promise<CallNowConfirmView> {
  if (view.lens !== 'client') {
    return { kind: 'expert_notice', engagementId: view.engagementId };
  }
  return {
    kind: 'client_terms',
    engagementId: view.engagementId,
    expertProfileId: view.expertProfileId,
    calleeOnline: read.calleeOnline,
    rateLine: await readCallNowRateLine(view.expertProfileId),
    inPlaceCandidate: read.inPlaceCandidate,
    bookInPage: canBookInPage({
      lens: view.lens,
      isOpen: view.header.isOpen,
      hasPublicProfile: view.party.profileHref !== null,
    }),
  };
}

export async function loadCaseCallNow(input: {
  view: CaseSurfaceView;
  /** The pending `readCallNowView` for this case, started before `loadCase` resolved. */
  read: Promise<CallNowViewRead | null>;
}): Promise<CaseCallNowView | null> {
  const { view } = input;
  const read = await input.read;
  if (read === null) return null;
  const entry = entryFor(read);
  if (entry === null) return null;
  return {
    entry,
    calleeLabel: view.conversation.counterpartyFirstName,
    onlineBadge: view.lens === 'client' && read.calleeOnline,
    calleeOnline: read.calleeOnline,
    calleeTimeZone: entry === 'outside_hours' ? read.calleeTimeZone : null,
    confirm: entry === 'button' ? await buildConfirm(view, read) : null,
  };
}
