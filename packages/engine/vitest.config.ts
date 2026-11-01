import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each test file has its own database in memory.
    fileParallelism: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      
      NODE_ENV: 'test',
    },
  },
});
