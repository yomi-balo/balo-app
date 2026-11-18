import crypto from 'node:crypto';

export { ADD_TO_CALENDAR_PATH_PREFIX } from '../calendar/add-to-calendar-path';

/**
 * The signed token behind Balo's "Add to calendar" page (`/add-to-calendar/{token}`), linked from
 * the calendar invite email. The token CARRIES the event (title, window, description, location) so
 * the page needs no database read and works for guests; the signature stops anyone minting a
 * Balo-branded page with event text Balo never wrote.
 *
 * ⚠ SERVER-ONLY (`node:crypto`) — a subpath of its own, never re-exported from
 * `@balo/shared/calendar`, which client components import.
 *
 * ⚠ NOT A CREDENTIAL, but it holds the counterparty's name and, for a member, the call URL — so
 * `/add-to-calendar/` is a `SENSITIVE_PATH_PREFIXES` entry and the token never reaches a log or
 * analytics URL.
 *
 * KEY: derived from `INTERNAL_API_SECRET` (already on both apps; same precedent as
 * `apps/api/src/services/calendar/connect-state.ts`) through a purpose-labelled HMAC, so a
 * signature made here can never verify anywhere that secret signs something else.
 */

export interface AddToCalendarEvent {
  readonly title: string;
  readonly startIso: string;
  readonly endIso: string;
  readonly details?: string;
  readonly location?: string;
}

const KEY_PURPOSE = 'balo:add-to-calendar-link:v1';
const PAYLOAD_VERSION = 1;
const MAX_TOKEN_LENGTH = 4096;
const MAX_TITLE_LENGTH = 300;
const MAX_DETAILS_LENGTH = 2000;
const MAX_LOCATION_LENGTH = 500;

interface WirePayload {
  v: number;
  t: string;
  s: string;
  e: string;
  d?: string;
  l?: string;
}

function deriveKey(secret: string): Buffer {
  return crypto.createHmac('sha256', secret).update(KEY_PURPOSE).digest();
}

function sign(payloadB64: string, secret: string): string {
  return crypto.createHmac('sha256', deriveKey(secret)).update(payloadB64).digest('base64url');
}

export function signAddToCalendarToken(
  event: Readonly<AddToCalendarEvent>,
  secret: string
): string {
  if (secret.length === 0) throw new Error('A signing secret is required');
  const wire: WirePayload = {
    v: PAYLOAD_VERSION,
    t: event.title,
    s: event.startIso,
    e: event.endIso,
  };
  if (event.details !== undefined) wire.d = event.details;
  if (event.location !== undefined) wire.l = event.location;
  // The SAME rules `verify` applies — so an event the page would reject (an over-long title, a
  // non-https location) fails here, loudly, instead of shipping a dead button.
  if (toEvent(wire) === null) throw new Error('Event is outside the add-to-calendar token limits');
  const payloadB64 = Buffer.from(JSON.stringify(wire)).toString('base64url');
  return `${payloadB64}.${sign(payloadB64, secret)}`;
}

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

function optionalString(value: unknown, max: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= max);
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function toEvent(parsed: unknown): AddToCalendarEvent | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { v, t, s, e, d, l } = parsed as Record<string, unknown>;
  if (v !== PAYLOAD_VERSION) return null;
  if (typeof t !== 'string' || t.length === 0 || t.length > MAX_TITLE_LENGTH) return null;
  if (!isIsoInstant(s) || !isIsoInstant(e) || Date.parse(e) <= Date.parse(s)) return null;
  if (!optionalString(d, MAX_DETAILS_LENGTH) || !optionalString(l, MAX_LOCATION_LENGTH)) {
    return null;
  }
  if (l !== undefined && !isHttpsUrl(l)) return null;
  return {
    title: t,
    startIso: s,
    endIso: e,
    ...(d === undefined ? {} : { details: d }),
    ...(l === undefined ? {} : { location: l }),
  };
}

/** The event a genuine token carries, or `null` for anything malformed, tampered or unsigned. */
export function verifyAddToCalendarToken(token: string, secret: string): AddToCalendarEvent | null {
  if (secret.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, providedSig] = parts as [string, string];

  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(sign(payloadB64, secret));
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    return toEvent(JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}
