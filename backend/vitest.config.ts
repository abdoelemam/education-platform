import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 20000,
    hookTimeout: 20000,
    // Integration suites share one MongoDB test database and clear collections
    // between tests. Running files sequentially prevents one suite's cleanup
    // from deleting another suite's fixtures mid-test.
    fileParallelism: false,
  },
});
