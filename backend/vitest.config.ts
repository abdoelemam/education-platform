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
    // Tests run against a dedicated local database and must not depend on the
    // developer's .env file. These values are applied to every worker's
    // process.env and override shell-provided variables, so the application
    // config always resolves MONGODB_URI to the test database. dotenv never
    // overrides existing process.env values, so `.env` cannot change them.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/education-platform-test',
      JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef',
      JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef',
    },
  },
});
