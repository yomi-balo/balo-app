import { defineConfig } from 'vitest/config';
import path from 'path';

/**
 * BAL-568 fix round 3 (H2) — the **`react-server`** vitest project.
 *
 * ⚠⚠ WHY A SECOND PROJECT EXISTS AT ALL. `vitest.config.ts` resolves `react` with no
 * `react-server` condition, so every suite there loads React's CLIENT build, where `cache` is a
 * pass-through. Any test asserting what `React.cache()` does or does not memoize is therefore
 * unfalsifiable in that project — which is how BAL-568's "two calls are two reads" assertion came
 * to pass for a reason unrelated to production. This project loads React's **server** build, the
 * only one where `cache()` has a scope to work in, so a `.react-server.test.ts` suite under `src`
 * can render through `react-server-dom-webpack/server` and measure the real thing. The default
 * project EXCLUDES those files (see `vitest.config.ts`), and the root `vitest.config.ts` lists this
 * config beside `apps/web`, so `pnpm test:run` / `pnpm test:coverage` run both.
 *
 * ⚠⚠ IT TAKES **TWO** KNOBS, AND EACH WAS MEASURED — they are not belt-and-braces:
 *
 *   1. `ssr.resolve.conditions` — how **Vite** resolves the bare `react` specifier for the modules
 *      it loads (the suite itself, and `src/lib/auth/live-user.ts`). Without it the suite fails
 *      loudly: "The `react` package in this environment is not configured correctly. The
 *      `react-server` condition must be enabled…". `resolve.conditions` alone does NOT work —
 *      vitest's node environment resolves through the SSR pipeline.
 *   2. `test.execArgv` — **Node's OWN** conditions inside the worker. The Flight server is a CJS
 *      file loaded natively, so its internal `require('react')` never passes through Vite. When a
 *      project is run from the ROOT config, vitest derives the worker's `--conditions` from the
 *      ROOT vite config rather than this one, so without this line the suite passes when run
 *      directly (`vitest --config vitest.rsc.config.ts`) and FAILS from the repo root — which is
 *      the way CI runs it.
 *
 * Both failures are loud, which is the safety net: this project cannot silently fall back to the
 * client build and keep passing — the Flight renderer refuses to start. (And if the two knobs ever
 * disagree, React would be loaded twice and the "one read inside a render" assertion would go red,
 * because the dispatcher would be set on the other instance.)
 *
 * ⚠ THE FLIGHT SERVER COMES FROM NEXT'S OWN TREE (`next/dist/compiled/react-server-dom-webpack`)
 * rather than a new devDependency: it is already installed, and a separate copy would have to be
 * kept version-locked to React by hand.
 *
 * ⚠ THE FILE IS NAMED `vitest.rsc.config.ts`, NOT `vitest.react-server.config.ts`, BECAUSE VITEST
 * CONSTRAINS IT: a config named in a root `projects` array must match
 * `^vite(?:st)?(?:\.\w+)?\.config\.` — `\w` excludes the hyphen, so the hyphenated name is
 * rejected at startup with that regex quoted back. Only the CONFIG name is constrained; the test
 * files keep the readable `.react-server.test.ts` suffix.
 */
export default defineConfig({
  test: {
    name: 'web-react-server',
    environment: 'node',
    include: ['src/**/*.react-server.test.ts'],
    execArgv: ['--conditions=react-server'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './src/test/server-only-stub.ts'),
    },
  },
  ssr: {
    resolve: {
      conditions: ['react-server', 'node', 'import', 'module', 'default'],
    },
  },
});
