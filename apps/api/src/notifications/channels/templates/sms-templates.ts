import { resolveAppUrl } from '../../../lib/app-url.js';

/** One SMS is 160 GSM-7 characters; past that it splits and bills as several. */
const SMS_MAX_LENGTH = 160;

/**
 * The longest caller label (company or first name) kept before the body is fitted. The fixed text
 * and the ring path take 88 characters and the shortest kept case title 13 (10 plus `...`), which
 * leaves 59 for the caller and the app origin: 28 here keeps an origin of up to 31 characters
 * (e.g. `https://app.staging.balo.expert`) inside 160.
 */
const MAX_CALLER_LENGTH = 28;

/** The least of a case title worth keeping when the rest of the body already fills the SMS. */
const MIN_CASE_TITLE_LENGTH = 10;

/** Typographic characters with a plain ASCII twin, mapped rather than dropped. */
const ASCII_TWINS: Readonly<Record<string, string>> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '“': "'",
  '”': "'",
  '„': "'",
  '–': '-',
  '—': '-',
  '−': '-',
  '…': '...',
  ' ': ' ',
};

/**
 * The GSM-7 basic characters a name or title may keep: printable ASCII less the extension table
 * (caret, braces, backslash, brackets, tilde, pipe: two septets each) plus the accented letters
 * the basic table carries. `"` is not here on purpose: it is mapped to `'` so a value cannot
 * close the copy's own quotes.
 */
const GSM7_KEPT = new Set(
  Array.from(
    " !#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz£¥èéùìòÇØøÅåÆæßÉ¡ÄÖÑÜ§¿äöñüà¤"
  )
);

/**
 * BAL-652 — make a user-supplied value (case title, company, first name) safe to interpolate into
 * the SMS: control characters and line breaks become one space, smart quotes, dashes and the
 * ellipsis become their ASCII twins, a letter GSM-7 lacks loses its accent ('João' → 'Joao'),
 * `"` becomes `'`, an `http(s)://` scheme is stripped so the
 * value cannot read as a second link, and any character left outside GSM-7 is dropped. One
 * non-GSM character would flip the whole message to UCS-2 and cut the limit from 160 to 70.
 */
/** Strips `http(s)://` until none is left, so a nested scheme cannot reassemble into a link. */
function stripSchemes(value: string): string {
  let current = value;
  let next = current.replaceAll(/https?:\/\//gi, '');
  while (next !== current) {
    current = next;
    next = current.replaceAll(/https?:\/\//gi, '');
  }
  return current;
}

/**
 * Replaces a character GSM-7 lacks with its unaccented base letter ('ã' → 'a', 'ë' → 'e'). A
 * character GSM-7 already carries ('é', 'ü', 'ñ') is returned untouched, so it keeps its accent.
 */
function transliterate(char: string): string {
  if (GSM7_KEPT.has(char)) {
    return char;
  }
  return char.normalize('NFD').replaceAll(/\p{M}/gu, '');
}

function sanitizeSmsText(value: string): string {
  const mapped = Array.from(value.normalize('NFC'), transliterate)
    .join('')
    .replaceAll(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replaceAll(/[‘-„–—−…\u00A0]/g, (char) => ASCII_TWINS[char] ?? ' ')
    .replaceAll('"', "'");
  const kept = Array.from(stripSchemes(mapped))
    .filter((char) => GSM7_KEPT.has(char))
    .join('');
  return kept.replaceAll(/\s+/g, ' ').trim();
}

/** A sanitised value, or the fallback when nothing printable survives. */
function sanitizedOr(value: unknown, fallback: string): string {
  const clean = typeof value === 'string' ? sanitizeSmsText(value) : '';
  return clean.length > 0 ? clean : fallback;
}

/** Caps a sanitised caller label at {@link MAX_CALLER_LENGTH} with an ASCII `...`. */
function capCaller(caller: string): string {
  if (caller.length <= MAX_CALLER_LENGTH) {
    return caller;
  }
  return `${caller.slice(0, MAX_CALLER_LENGTH - 3).trimEnd()}...`;
}

/**
 * BAL-652 — shorten `{case}` so the whole body fits one SMS. ASCII `...`, never `…`: a single
 * non-GSM character flips the whole message to UCS-2 and cuts the limit to 70. A title that
 * cannot fit even at {@link MIN_CASE_TITLE_LENGTH} keeps that much; the adapter's >160 warning
 * covers the overflow.
 */
function fitCaseTitle(title: string, bodyWithoutTitle: string): string {
  const budget = SMS_MAX_LENGTH - bodyWithoutTitle.length;
  if (title.length <= budget) {
    return title;
  }
  const keep = Math.max(MIN_CASE_TITLE_LENGTH, budget - 3);
  return `${title.slice(0, keep).trimEnd()}...`;
}

/** The SMS link: the web redirect that opens the live call room, or the case once the ring is over. */
function callNowLink(ringId: unknown): string {
  return resolveAppUrl(
    typeof ringId === 'string' && ringId.length > 0 ? `/call-now/${encodeURIComponent(ringId)}` : ''
  );
}

/** BAL-652 — "Balo: {caller} is calling you now about "{case}". Join: {link}" (copy sheet §1). */
function incomingCallSms(
  rawCaller: unknown,
  callerFallback: string,
  data: Record<string, unknown>
): string {
  const caller = capCaller(sanitizedOr(rawCaller, callerFallback));
  const title = sanitizedOr(data.callCaseTitle, 'your case');
  const link = callNowLink(data.ringId);
  const frame = (caseTitle: string): string =>
    `Balo: ${caller} is calling you now about "${caseTitle}". Join: ${link}`;
  return frame(fitCaseTitle(title, frame('')));
}

const templates: Record<string, (data: Record<string, unknown>) => string> = {
  // BAL-400 (D4) — no `booking-confirmed-sms` entry: the legacy SMS rule at booking time was
  // structurally incapable of firing (the resolver hydrates `data.user` from `payload.userId`
  // only, which `BookingConfirmedPayload` never carries) and the ticket's own spec puts SMS at
  // the ~2h reminder — a separate, unbuilt event. See `engine/rules.ts`'s `booking.confirmed`.
  'booking-reminder-sms': () => {
    return 'Balo: Reminder - your consultation starts in 30 min. Join at balo.expert';
  },

  // BAL-378 (ADR-1040 Lane 2) — the two urgent, time-sensitive session moments (entering
  // grace, nearing the wrap). ≤160 chars, warm, NO "overdraft" (its client name is "extra
  // time"). Self recipient, verified-phone gated at the rule.
  'session-grace-entered-sms': () => {
    return 'Balo: Your session is continuing past your balance — the extra time settles afterward. No action needed.';
  },

  'session-near-wrap-sms': () => {
    return 'Balo: Your session is nearing the end of its extra time — top up any time to stay ahead of it.';
  },

  // BAL-411 — the expert proposed alternative times AND the original start is under 2h away
  // (`rescheduleProposalIsUrgent`). ≤160 chars, warm, NO countdown language beyond the plain
  // fact that the original time is soon.
  'reschedule-proposal-sent-sms': () => {
    return 'Balo: A new time was suggested for your consultation, coming up soon. Check the case to pick a time or keep your original booking.';
  },

  // BAL-652 — the incoming Call now ring. Prospective copy names the PARTY: the client company to
  // an expert, the expert's first name to a client (copy sheet §1). Opt-in, hours, presence and
  // the daily cap were decided before the ring was written, so nothing is re-checked here.
  'call-ringing-sms-expert': (data) => incomingCallSms(data.callerCompanyName, 'Your client', data),
  'call-ringing-sms-client': (data) => incomingCallSms(data.callerFirstName, 'Your expert', data),
};

export function getSmsTemplate(templateName: string, data: Record<string, unknown>): string {
  const factory = templates[templateName];
  if (!factory) {
    throw new Error(`Unknown SMS template: ${templateName}`);
  }
  return factory(data);
}

/**
 * Fix round 1 item 11 — every REGISTERED template name, for a test to iterate rather than
 * hand-maintain a parallel literal array (`sms-templates.test.ts` had frozen one at a single
 * entry, so the ≤160-char invariant this module's own comments assert silently stopped
 * covering every template added after it).
 */
export function listSmsTemplates(): string[] {
  return Object.keys(templates);
}
