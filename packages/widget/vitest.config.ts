import { defineConfig } from 'vitest/config';

// The client's tests run in Node against a real server; the panel's run in happy-dom (each such file
// says so with its own `@vitest-environment` comment).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
