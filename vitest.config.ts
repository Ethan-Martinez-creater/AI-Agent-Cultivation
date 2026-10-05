import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
    // Durable migrations and streamed file recovery share Windows disk I/O.
    // Serial files avoid fixture timeouts without weakening assertions or skipping tests.
    maxWorkers: 1,
  },
});
