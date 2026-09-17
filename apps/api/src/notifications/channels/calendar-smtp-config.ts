import { createLogger } from '@balo/shared/logging';

const log = createLogger('calendar-smtp-config');

const DEFAULT_HOST = 'smtp-relay.brevo.com';
const DEFAULT_PORT = 587;
const SECURE_PORT = 465;

export interface CalendarSmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly pass: string;
  /** Balo's no-reply mailbox — the SMTP `From` AND the ICS `ORGANIZER`. */
  readonly organizerAddress: string;
}

/**
 * BAL-475 — reads the Brevo SMTP relay config (ADR-1044 Ruling 4). PURE — no nodemailer here;
 * the transport itself is built only inside `email.adapter.ts` (the counterparty-address
 * invariant's `nodemailer-only-in-email-channel.test.ts` pins that single import site).
 *
 * `undefined` unless `BREVO_SMTP_USER`, `BREVO_SMTP_PASS` and `CALENDAR_INVITE_ORGANIZER_EMAIL`
 * are ALL non-blank AFTER TRIMMING (F18, fix round 1 — R17/S13: a whitespace-only value used to
 * count as configured and then fail at AUTH/DATA instead of degrading to
 * `smtp_not_configured`) (host/port default). A malformed OR out-of-range port (outside
 * `1..65535`) degrades to `undefined` + one warn — NEVER a crash: absent config means every
 * `meeting.calendar_invite` delivery is SKIPPED and logged, but boot must still succeed.
 *
 * ⚠ NEVER LOGS A CREDENTIAL OR ADDRESS — the port itself is not secret and IS logged on a
 * malformed value (F18: the docblock previously overclaimed "never logs A VALUE").
 */
export function readCalendarSmtpConfig(): CalendarSmtpConfig | undefined {
  const user = (process.env.BREVO_SMTP_USER ?? '').trim();
  const pass = (process.env.BREVO_SMTP_PASS ?? '').trim();
  const organizerAddress = (process.env.CALENDAR_INVITE_ORGANIZER_EMAIL ?? '').trim();

  if (user.length === 0 || pass.length === 0 || organizerAddress.length === 0) {
    return undefined;
  }

  const host = process.env.BREVO_SMTP_HOST?.trim() || DEFAULT_HOST;
  const rawPort = process.env.BREVO_SMTP_PORT?.trim();
  const port = rawPort === undefined || rawPort.length === 0 ? DEFAULT_PORT : Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    log.warn(
      { port: rawPort },
      'BREVO_SMTP_PORT is not a valid port — calendar invite SMTP is unconfigured'
    );
    return undefined;
  }

  return {
    host,
    port,
    secure: port === SECURE_PORT,
    user,
    pass,
    organizerAddress,
  };
}
