import type { CaseSelection } from './step-confirm';
import type { GuestDraft } from './guest-invite-composer';

/**
 * The on-device draft of a booking's typed fields, so a client who leaves to fix funding (or a
 * member who saves for a billing admin) finds Review & confirm filled in on return.
 *
 * ⚠ THE TIME IS NEVER STORED. A draft restores the fields only; the client picks a time again.
 *
 * One entry per owner, expert and company: the key is
 * `balo:booking-draft:{ownerUserId}:{expertProfileId}:{companyId|none}`. Every storage call is
 * wrapped, because a disabled store or a private window throws and a draft is never worth a crash.
 * Sign-out sweeps the whole prefix ({@link clearAllBookingDrafts}).
 */

export const BOOKING_DRAFT_KEY_PREFIX = 'balo:booking-draft:';
export const BOOKING_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DRAFT_VERSION = 1;

export interface BookingDraftScope {
  readonly ownerUserId: string;
  readonly expertProfileId: string;
}

export interface BookingDraft {
  readonly title: string;
  readonly descriptionHtml: string;
  readonly productIds: readonly string[];
  readonly guests: readonly GuestDraft[];
  readonly caseSelection: CaseSelection;
  readonly companyId: string | null;
}

function scopePrefix(scope: BookingDraftScope): string {
  return `${BOOKING_DRAFT_KEY_PREFIX}${scope.ownerUserId}:${scope.expertProfileId}:`;
}

function draftKey(scope: BookingDraftScope, companyId: string | null): string {
  return `${scopePrefix(scope)}${companyId ?? 'none'}`;
}

function getStorage(): Storage | null {
  if (globalThis.window === undefined) return null;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/** Every stored key that starts with `prefix`, collected first so removal cannot skip an entry. */
function keysWithPrefix(storage: Storage, prefix: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

function removeKeys(storage: Storage, keys: readonly string[]): void {
  for (const key of keys) {
    try {
      storage.removeItem(key);
    } catch {
      // Nothing to clear either way.
    }
  }
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function readGuests(value: unknown): GuestDraft[] {
  if (!Array.isArray(value)) return [];
  const guests: GuestDraft[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const { email, name } = item as Record<string, unknown>;
    if (typeof email !== 'string') continue;
    guests.push(typeof name === 'string' ? { email, name } : { email });
  }
  return guests;
}

function readCaseSelection(value: unknown): CaseSelection {
  if (typeof value === 'object' && value !== null) {
    const { kind, engagementId } = value as Record<string, unknown>;
    if (kind === 'existing' && typeof engagementId === 'string') {
      return { kind: 'existing', engagementId };
    }
  }
  return { kind: 'new' };
}

interface StoredDraft {
  readonly savedAt: number;
  readonly draft: BookingDraft;
}

/** Narrow one stored value, or `null` when it is not a version-1 draft. */
function parseStoredDraft(raw: string): StoredDraft | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== DRAFT_VERSION) return null;
  const { savedAt, title, descriptionHtml, companyId } = record;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null;
  if (typeof title !== 'string' || typeof descriptionHtml !== 'string') return null;
  return {
    savedAt,
    draft: {
      title,
      descriptionHtml,
      productIds: readStringArray(record.productIds),
      guests: readGuests(record.guests),
      caseSelection: readCaseSelection(record.caseSelection),
      companyId: typeof companyId === 'string' ? companyId : null,
    },
  };
}

export function writeBookingDraft(
  scope: BookingDraftScope,
  draft: BookingDraft,
  now: number = Date.now()
): void {
  const storage = getStorage();
  if (storage === null) return;
  try {
    storage.setItem(
      draftKey(scope, draft.companyId),
      JSON.stringify({ v: DRAFT_VERSION, savedAt: now, ...draft })
    );
  } catch {
    // A full or disabled store: the draft is a convenience, never a requirement.
  }
}

/**
 * The freshest unexpired draft for this owner and expert whose company is still one of the
 * viewer's eligible companies. Expired and malformed entries are removed as they are found.
 */
export function readBookingDraft(
  scope: BookingDraftScope,
  eligibleCompanyIds: readonly string[],
  now: number = Date.now()
): BookingDraft | null {
  const storage = getStorage();
  if (storage === null) return null;
  try {
    let freshest: StoredDraft | null = null;
    const stale: string[] = [];
    for (const key of keysWithPrefix(storage, scopePrefix(scope))) {
      const raw = storage.getItem(key);
      const stored = raw === null ? null : parseStoredDraft(raw);
      if (stored === null || now - stored.savedAt > BOOKING_DRAFT_TTL_MS) {
        stale.push(key);
        continue;
      }
      const { companyId } = stored.draft;
      if (companyId === null || !eligibleCompanyIds.includes(companyId)) continue;
      if (freshest === null || stored.savedAt > freshest.savedAt) freshest = stored;
    }
    removeKeys(storage, stale);
    return freshest?.draft ?? null;
  } catch {
    return null;
  }
}

/** Every company's draft for this owner and expert. */
export function clearBookingDrafts(scope: BookingDraftScope): void {
  const storage = getStorage();
  if (storage === null) return;
  try {
    removeKeys(storage, keysWithPrefix(storage, scopePrefix(scope)));
  } catch {
    // Nothing to clear either way.
  }
}

/** Every booking draft on this device, for sign-out. */
export function clearAllBookingDrafts(): void {
  const storage = getStorage();
  if (storage === null) return;
  try {
    removeKeys(storage, keysWithPrefix(storage, BOOKING_DRAFT_KEY_PREFIX));
  } catch {
    // Nothing to clear either way.
  }
}
