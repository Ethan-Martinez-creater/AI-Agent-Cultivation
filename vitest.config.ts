import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
    // Bounded concurrency avoids disk contention between durable SQLite/recovery fixtures.
    maxWorkers: 4,
  },
});
