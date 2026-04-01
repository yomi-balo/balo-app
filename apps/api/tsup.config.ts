import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  // Bundle workspace packages that export raw TypeScript (main: ./src/index.ts)
  noExternal: ['@balo/shared', '@balo/db'],
  // Pino transports use require.resolve() + worker threads at runtime —
  // they MUST stay external so Node can find them in node_modules
  external: ['pino', 'pino-pretty', '@axiomhq/pino'],
  // CJS deps (drizzle, postgres) use require() for Node built-ins — shim in ESM
  banner: {
    js: `import { createRequire as __cjsRequire } from 'module'; const require = __cjsRequire(import.meta.url);`,
  },
});
