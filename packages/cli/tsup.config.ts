import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: true,
  sourcemap: true,
  target: 'node20',
  // Shebang + createRequire shim so bundled CJS deps (like commander)
  // can still do require('events') etc from inside the ESM bundle.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __hiraCreateRequire } from 'node:module';",
      'const require = __hiraCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  // Bundle everything (workspace + npm deps) into a single dist/index.js
  // so the CLI is self-contained for `pnpm link --global` or a plain
  // symlink. node: built-ins stay external automatically.
  noExternal: [/.*/],
});
