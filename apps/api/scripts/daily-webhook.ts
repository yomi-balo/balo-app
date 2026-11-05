/**
 * BAL-518 — VERIFY / SYNC THE DAILY WEBHOOK FOR ONE ENVIRONMENT.
 * **MANUAL. NOT WIRED INTO CI.** Run once per environment during the Daily domain cutover
 * (`docs/ops/daily-domain-cutover.md`).
 *
 *   verify [--url <u>]
 *       Prints the domain name and each registered webhook (state, retry type, event-type diff,
 *       hmac match). Exit 1 on any webhook drift. The hmac is checked only when
 *       DAILY_WEBHOOK_SECRET is set; otherwise it prints "hmac: not checked".
 *
 *   sync --url <u> [--apply] [--force-update]
 *       Creates / updates the webhook. DRY-RUN BY DEFAULT: prints the plan and the request body
 *       with `hmac: '[redacted]'`. `--apply` executes, then re-runs `verify`.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────────────────
 *
 *   The values are the TARGET environment's (its Daily key and webhook secret), kept in a
 *   git-ignored env file and loaded with dotenv, never typed on the command line:
 *
 *   npx dotenv -e <target-env-file> -- \
 *     npx tsx apps/api/scripts/daily-webhook.ts sync --url https://<api-host>/webhooks/daily
 *
 *   `verify` needs DAILY_API_KEY (and DAILY_WEBHOOK_SECRET to check the hmac). Neither value is
 *   ever printed. A webhook url prints as origin + path only. A failed Daily call prints the
 *   method, path, status and the vendor's `error` field, redacted; never the raw body.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────────────────
 *
 *   The `getbalo` domain and its only webhook subscription belong to the Bubble app. `sync`
 *   REFUSES when the key's domain is `getbalo` or when any existing webhook points at a
 *   different url, and never deletes anything.
 *
 * ── ⚠ THIS FILE IS OUTSIDE THE APP'S TYPECHECK AND LINT SCOPE ───────────────────────────
 *
 * Like `daily-token-smoke.ts`: `scripts/` is covered by neither `pnpm typecheck` nor lint.
 * Verify by hand after editing:
 *
 *   npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler \
 *     --strict --skipLibCheck --esModuleInterop --types node \
 *     apps/api/scripts/daily-webhook.ts
 */
import { parseArgs } from 'node:util';
import { DailyApiError } from '../src/services/daily/errors.js';
import {
  formatDailyApiFailure,
  redactSecrets,
  runDailyWebhookSync,
  runDailyWebhookVerify,
  type DailyWebhookVerifyReport,
} from '../src/services/daily/webhook-subscription.js';

/** Thrown by `fail`; the top-level handler prints it without a stack and sets the exit code. */
class ScriptFailure extends Error {}

function fail(message: string): never {
  throw new ScriptFailure(message);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    return fail(`${name} is not set`);
  }
  return value;
}

function printVerify(report: DailyWebhookVerifyReport): void {
  console.log(`domain:           ${report.domainName}`);
  if (report.hooks.length === 0) {
    console.log('no webhooks registered');
  }
  for (const hook of report.hooks) {
    console.log(`webhook ${hook.uuid}`);
    console.log(`  url:         ${hook.url}`);
    console.log(`  state:       ${hook.state}`);
    console.log(`  retryType:   ${hook.retryType}`);
    console.log(`  failedCount: ${hook.failedCount ?? 'n/a'}`);
    console.log(`  missing:     ${hook.missing.length === 0 ? '-' : hook.missing.join(', ')}`);
    console.log(`  extra:       ${hook.extra.length === 0 ? '-' : hook.extra.join(', ')}`);
    console.log(`  hmac:        ${hook.hmac}`);
    for (const reason of hook.reasons) {
      console.log(`  DRIFT: ${reason}`);
    }
  }
  console.log(report.drifted ? 'VERIFY: DRIFT' : 'VERIFY: OK');
}

function optionalSecret(): string | undefined {
  const secret = process.env.DAILY_WEBHOOK_SECRET;
  return secret === undefined || secret.length === 0 ? undefined : secret;
}

async function verify(url: string | undefined): Promise<void> {
  const report = await runDailyWebhookVerify({ url, secret: optionalSecret() });
  printVerify(report);
  if (report.drifted) {
    process.exitCode = 1;
  }
}

async function sync(url: string, apply: boolean, forceUpdate: boolean): Promise<void> {
  const report = await runDailyWebhookSync({
    url,
    secret: requireEnv('DAILY_WEBHOOK_SECRET'),
    apply,
    forceUpdate,
  });

  console.log(`domain: ${report.domainName}`);
  console.log(`plan:   ${report.plan.kind}`);
  if (report.plan.kind === 'refuse') {
    return fail(`REFUSED: ${report.plan.reason}`);
  }
  if (report.plan.kind === 'update') {
    console.log(`reasons: ${report.plan.reasons.join('; ')}`);
  }
  if (report.body !== null) {
    console.log(`body: ${JSON.stringify(report.body, null, 2)}`);
  }
  if (!apply) {
    console.log('DRY RUN — nothing changed. Re-run with --apply to execute.');
    return;
  }

  if (report.applied !== null) {
    console.log(`${report.applied.action} webhook ${report.applied.uuid}`);
  }
  if (report.verify !== null) {
    console.log('\nre-verifying:');
    printVerify(report.verify);
    if (report.verify.drifted) {
      fail('post-apply verify found drift');
    }
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'force-update': { type: 'boolean', default: false },
    },
  });
  const [command] = positionals;
  requireEnv('DAILY_API_KEY');

  if (command === 'verify') {
    await verify(values.url);
    return;
  }
  if (command === 'sync') {
    if (values.url === undefined) {
      return fail('sync requires --url <https://host/webhooks/daily>');
    }
    await sync(values.url, values.apply === true, values['force-update'] === true);
    return;
  }
  return fail(
    'usage: daily-webhook.ts verify [--url <u>] | sync --url <u> [--apply] [--force-update]'
  );
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  const secrets = [process.env.DAILY_WEBHOOK_SECRET ?? '', process.env.DAILY_API_KEY ?? ''];
  if (error instanceof ScriptFailure) {
    console.error(error.message);
  } else if (error instanceof DailyApiError) {
    console.error(`FAIL  ${formatDailyApiFailure(error, secrets)}`);
  } else {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error), secrets));
  }
});
