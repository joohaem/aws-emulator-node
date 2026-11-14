import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Booting the router assembles every service; give the first test in a file room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      // Keep test runs from reporting usage telemetry.
      EMULATOR_TELEMETRY: 'off',
    },
  },
});
