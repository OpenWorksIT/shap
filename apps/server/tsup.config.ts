import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts', 'src/db/migrate-cli.ts', 'src/db/seed.ts', 'src/db/create-owner.ts', 'src/db/import-cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle the shared workspace package; keep real npm deps external.
  noExternal: ['@shap/shared'],
});
