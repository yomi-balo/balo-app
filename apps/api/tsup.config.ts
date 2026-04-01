import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  // Bundle workspace packages that export raw TypeScript
  noExternal: ['@balo/shared'],
  // Pino and other CJS deps use require() for Node built-ins — shim it in ESM
  // Use unique name to avoid collision with source-level createRequire imports
  banner: {
    js: `import { createRequire as __cjsRequire } from 'module'; const require = __cjsRequire(import.meta.url);`,
  },
});
