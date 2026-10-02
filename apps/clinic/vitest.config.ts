import { defineConfig } from 'vitest/config';

// Every test file starts with the clinic registered as the default app (src/testing/setup.ts).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/testing/setup.ts'],
  },
});
