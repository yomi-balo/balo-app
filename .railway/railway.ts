// Railway Infrastructure as Code for the balo-app API service.
//
// Railway does NOT read this file at deploy time. `.github/workflows/railway-config.yml` plans it
// on pull requests and applies the reviewed plan on merge, writing these values into the
// service's settings. A changed setting reaches the running service only through a deployment
// made after the apply: use "Deploy Latest Commit", because redeploying an existing deployment
// reuses the config it was built with.
//
// Recovery: if the merge-time apply fails (no plan artifact, or the environment drifted after the
// plan), run `railway config plan` then `railway config apply` from an up-to-date `main` checkout
// linked to atlas-api/production.
//
// This is a named partial: it owns only `service.balo-app`. The project's Redis service and the
// service variables (MIGRATION_DATABASE_URL and the secrets) are deliberately outside it and stay
// managed in the Railway dashboard.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
import { defineRailway, github, project, service } from 'railway/iac';
export const partial = 'balo-app';
export default defineRailway(() => {
  const baloApp = service('balo-app', {
    source: github('yomi-balo/balo-app', { branch: 'main', checkSuites: true, rootDirectory: '/' }),
    build: {
      buildCommand: 'pnpm install --frozen-lockfile && pnpm build --filter api',
      buildEnvironment: 'V3',
      builder: 'RAILPACK',
      watchPatterns: ['apps/api/**', 'packages/**'],
    },
    // TZ and NODE_ENV are pinned inline here, never as service variables, so they live in
    // checked-in, reviewed config.
    //
    // TZ=UTC pins the process timezone: the availability resolver iterates local-midnight Date
    // objects (getDay()/setDate()), which are only correct when the server runs UTC.
    //
    // NODE_ENV=production: `apps/api` starts with a bare `node dist/index.js` (unlike `apps/web`,
    // where `next start` sets NODE_ENV itself), and `app.ts`'s dev-route gate is
    // `if (process.env.NODE_ENV !== 'production')`, which FAILS OPEN on an unset variable: with
    // NODE_ENV unset it registers the BAL-239 seed routes on the deployed API. They still sit behind
    // `requireInternalAuth`, and past that only `truncateSeedData`'s NODE_ENV allowlist
    // (apps/api/src/services/seed/truncate.ts) stops them hard-deleting meetings, engagements,
    // transcripts, meeting_guests and audit rows. This pin keeps that allowlist from being the last
    // guard. Do not remove it without closing that gate some other way.
    start: 'TZ=UTC NODE_ENV=production node apps/api/dist/index.js',
    healthcheck: '/health',
    // Applies pending Drizzle migrations before the new build takes traffic. `drizzle-kit migrate`
    // applies every pending journal entry in ONE transaction and records each in
    // `drizzle.__drizzle_migrations`. A failing migration rolls the whole batch back and fails the
    // deploy, so the previous build keeps serving. A migration that succeeds is never undone, even
    // when the new build then fails its healthcheck, so the previous build must keep working on the
    // migrated schema: expand/contract (CLAUDE.md, Database). Vercel deploys apps/web on its own
    // schedule, so a new web build can also run against the old schema until this step commits;
    // that gap is open (recorded on BAL-307).
    //
    // drizzle-kit connects with the MIGRATION_DATABASE_URL service variable: Supabase's session
    // pooler, the shared `*.pooler.supabase.com` host on port 5432. (The direct
    // db.<ref>.supabase.co host is IPv6-only, which Railway reaches only with outbound IPv6
    // enabled.) drizzle.config.ts refuses the transaction pooler (:6543) the API connects through
    // rather than fall back to it, and `migrate` falls back to DATABASE_URL only for a local
    // database, so the variable is required here; see packages/db/src/migration-database-url.ts.
    // drizzle-kit is a runtime dependency of @balo/db so this step survives dev-dependency
    // pruning. The command stays shell-free because Railway does not document whether a
    // pre-deploy command runs through a shell.
    preDeploy: 'pnpm --filter @balo/db db:migrate',
    replicas: { 'asia-southeast1-eqsg3a': 1 },
    deploy: {
      // Without a cap, a migration waiting on a lock holds the deploy "in progress" indefinitely.
      preDeployTimeoutSeconds: 600,
      // Matches Railway's default; declared so a dashboard edit can't silently change it.
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
    },
  });

  return project('atlas-api', {
    // The service variables stay owned by the Railway dashboard (see the header).
    variables: { managed: false },
    resources: [baloApp],
  });
});
