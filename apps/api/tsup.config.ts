import { defineConfig } from 'tsup';

// One self-contained file for the Docker image: no node_modules needed at runtime.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  bundle: true,
  noExternal: [/.*/],
  splitting: false,
  sourcemap: false,
  clean: true,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" }
});
