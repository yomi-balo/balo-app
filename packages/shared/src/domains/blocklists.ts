/**
 * Domain blocklists (BAL-344 / ADR-1031) — the two data sets consulted by
 * `isBlockedDomain` to decide whether an email domain may be auto-captured as a
 * corporate identity. Kept as compact iterable data (a single `new Set([...])`
 * per list) so the list grows by adding an entry, never by copy-pasting logic.
 *
 * `ReadonlySet` so consumers can only test membership, never mutate the shared
 * platform-wide list. Pure data — no `db`, no I/O, importable by any layer.
 */

/** Consumer/free webmail providers — a corporate identity signal of ZERO. */
export const FREEMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'aol.com',
  'gmx.com',
  'gmx.net',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.com',
  'mail.ru',
  'fastmail.com',
  'hey.com',
  'tutanota.com',
  'tuta.io',
  // extend as needed — data-driven, iterate not copy-paste
]);

/** Disposable / throwaway inbox providers — maintained list. */
export const DISPOSABLE_DOMAINS: ReadonlySet<string> = new Set([
  'mailinator.com',
  'guerrillamail.com',
  'guerrillamail.info',
  '10minutemail.com',
  'temp-mail.org',
  'tempmail.com',
  'throwawaymail.com',
  'yopmail.com',
  'getnada.com',
  'trashmail.com',
  'sharklasers.com',
  'dispostable.com',
  'maildrop.cc',
  'fakeinbox.com',
  'mailnesia.com',
  'mohmal.com',
  // maintained — a future BAL ticket may swap for a generated/synced source
]);
