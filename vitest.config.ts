import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
    // Durable migrations and streamed file recovery can exceed Vitest's 5s default on Windows.
    // Serial files plus a bounded 15s per-test timeout preserve assertions without flaky I/O failures.
    maxWorkers: 1,
    testTimeout: 15_000,
  },
});
