import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts'],
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: true,
  target: 'node20',
  // server.js is spawned standalone as an MCP server — bundle everything
  // and add a createRequire shim so bundled CJS deps resolve.
  noExternal: [/.*/],
  banner: {
    js: [
      'import { createRequire as __hiraCreateRequire } from "node:module";',
      'const require = __hiraCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
